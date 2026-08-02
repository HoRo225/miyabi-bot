#!/bin/sh
set -eu

image="${1:-}"
[ -n "$image" ] || { echo "usage: backup.test.sh IMAGE" >&2; exit 2; }
docker_bin="${DOCKER_BIN:-docker}"
root="$(mktemp -d)"
trap 'chmod -R u+w "$root" 2>/dev/null || true; rm -rf "$root"' EXIT HUP INT TERM
data_dir="$root/data"
backup_dir="$root/backups"
bad_dir="$root/bad"
readonly_dir="$root/readonly"
status_dir="$data_dir/status"
mkdir -p "$data_dir" "$backup_dir" "$bad_dir" "$readonly_dir" "$status_dir"
user="$(id -u):$(id -g)"

"$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" -v "$data_dir:/app/data" "$image" node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync("/app/data/bot.sqlite");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1);");
  db.close();
'

source_hash="$(sha256sum "$data_dir/bot.sqlite" | awk '{print $1}')"
for stamp in 20260101T000001Z 20260101T000002Z 20260101T000003Z 20260101T000004Z 20260101T000005Z 20260101T000006Z 20260101T000007Z 20260101T000008Z; do
  touch "$backup_dir/bot-$stamp.sqlite"
done

output="$("$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" -e DATABASE_PATH=/app/data/bot.sqlite -e BACKUP_DIR=/backups -e STATUS_DIR=/app/data/status -v "$data_dir:/app/data:ro" -v "$status_dir:/app/data/status" -v "$backup_dir:/backups" "$image" node /app/ops/backup.mjs)"
backup_name="$(printf '%s\n' "$output" | tail -n 1 | sed 's#^/backups/##')"
case "$backup_name" in bot-[0-9]*T[0-9]*Z.sqlite) ;; *) echo "invalid backup output" >&2; exit 1 ;; esac
[ -f "$backup_dir/$backup_name" ]
[ "$(stat -c '%a' "$backup_dir/$backup_name")" = 600 ]
[ "$(sha256sum "$data_dir/bot.sqlite" | awk '{print $1}')" = "$source_hash" ]
[ -f "$status_dir/backup.json" ]
[ "$(stat -c '%a' "$status_dir")" = 700 ]
[ "$(stat -c '%a' "$status_dir/backup.json")" = 600 ]

assert_status() {
  expected_state="$1"
  expected_error="$2"
  "$docker_bin" run --rm --network none --read-only --user "$user" -e STATUS=/app/data/status/backup.json -e EXPECTED_STATE="$expected_state" -e EXPECTED_ERROR="$expected_error" -v "$status_dir:/app/data/status:ro" "$image" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const status = JSON.parse(readFileSync(process.env.STATUS, "utf8"));
    const fields = ["errorCode", "lastErrorAt", "lastSuccessAt", "module", "state"];
    if (JSON.stringify(Object.keys(status).sort()) !== JSON.stringify(fields)) process.exit(1);
    if (status.module !== "backup" || status.state !== process.env.EXPECTED_STATE) process.exit(1);
    if (status.errorCode !== (process.env.EXPECTED_ERROR || null)) process.exit(1);
    if (typeof status.lastSuccessAt !== "string") process.exit(1);
    if (process.env.EXPECTED_STATE === "ready" && status.lastErrorAt !== null) process.exit(1);
    if (process.env.EXPECTED_STATE === "degraded" && typeof status.lastErrorAt !== "string") process.exit(1);
  '
}
assert_status ready ""

count=0
for path in "$backup_dir"/bot-*.sqlite; do
  [ -e "$path" ] || continue
  count=$((count + 1))
done
[ "$count" -eq 7 ]

for path in "$backup_dir"/*.partial "$backup_dir"/*-wal "$backup_dir"/*-shm; do
  [ ! -e "$path" ] || { echo "backup sidecar remains: $path" >&2; exit 1; }
done

"$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" -e TARGET="/backups/$backup_name" -v "$backup_dir:/backups:ro" "$image" node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.env.TARGET, { readOnly: true });
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") process.exit(1);
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) process.exit(1);
  if (db.prepare("SELECT count(*) AS count FROM child").get().count !== 1) process.exit(1);
  db.close();
'

if "$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" -e DATABASE_PATH=/app/data/missing.sqlite -e BACKUP_DIR=/backups -e STATUS_DIR=/app/data/status -v "$data_dir:/app/data:ro" -v "$status_dir:/app/data/status" -v "$bad_dir:/backups" "$image" node /app/ops/backup.mjs >/dev/null 2>&1; then
  echo "missing source unexpectedly backed up" >&2
  exit 1
fi
[ -z "$(ls -A "$bad_dir")" ]
assert_status degraded BACKUP-001

if "$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" -e DATABASE_PATH=/app/data/bot.sqlite -e BACKUP_DIR=/backups -e STATUS_DIR=/app/data/status -v "$data_dir:/app/data:ro" -v "$status_dir:/app/data/status" -v "$readonly_dir:/backups:ro" "$image" node /app/ops/backup.mjs >/dev/null 2>&1; then
  echo "read-only target unexpectedly accepted" >&2
  exit 1
fi
[ -z "$(ls -A "$readonly_dir")" ]

symlink_status_target="$root/status-target"
symlink_status_link="$root/status-link"
mkdir -p "$symlink_status_target"
ln -s "$symlink_status_target" "$symlink_status_link"
if "$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" \
  -e DATABASE_PATH=/workspace/missing.sqlite -e BACKUP_DIR=/workspace/symlink-backups -e STATUS_DIR=/workspace/status-link \
  -v "$root:/workspace" "$image" node /app/ops/backup.mjs >/dev/null 2>&1; then
  echo "symlinked status directory unexpectedly accepted" >&2
  exit 1
fi
[ -z "$(ls -A "$symlink_status_target")" ]

target_status_dir="$root/target-status"
target_status_referent="$root/target-status-referent.json"
target_status_path="$target_status_dir/backup.json"
mkdir -p "$target_status_dir"
printf 'sentinel\n' > "$target_status_referent"
ln -s "$target_status_referent" "$target_status_path"
if "$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" \
  -e DATABASE_PATH=/workspace/missing.sqlite -e BACKUP_DIR=/workspace/target-backups -e STATUS_DIR=/workspace/target-status \
  -e STATUS_PATH=/workspace/target-status/backup.json -v "$root:/workspace" "$image" node /app/ops/backup.mjs >/dev/null 2>&1; then
  echo "symlinked backup status target unexpectedly accepted" >&2
  exit 1
fi
[ "$(cat "$target_status_referent")" = sentinel ]
[ -L "$target_status_path" ]

symlink_backup_target="$root/backup-target"
symlink_backup_link="$root/backup-link"
normal_status_dir="$root/normal-status"
mkdir -p "$symlink_backup_target" "$normal_status_dir"
ln -s "$symlink_backup_target" "$symlink_backup_link"
if "$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" \
  -e DATABASE_PATH=/workspace/data/bot.sqlite -e BACKUP_DIR=/workspace/backup-link -e STATUS_DIR=/workspace/normal-status \
  -v "$root:/workspace" "$image" node /app/ops/backup.mjs >/dev/null 2>&1; then
  echo "symlinked backup directory unexpectedly accepted" >&2
  exit 1
fi
[ -z "$(ls -A "$symlink_backup_target")" ]
[ -f "$normal_status_dir/backup.json" ]
[ "$(stat -c '%a' "$normal_status_dir/backup.json")" = 600 ]
"$docker_bin" run --rm --network none --read-only --user "$user" -e STATUS=/workspace/normal-status/backup.json \
  -v "$root:/workspace:ro" "$image" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const status = JSON.parse(readFileSync(process.env.STATUS, "utf8"));
    const fields = ["errorCode", "lastErrorAt", "lastSuccessAt", "module", "state"];
    if (JSON.stringify(Object.keys(status).sort()) !== JSON.stringify(fields)) process.exit(1);
    if (status.module !== "backup" || status.state !== "degraded" || status.errorCode !== "BACKUP-001") process.exit(1);
    if (typeof status.lastErrorAt !== "string") process.exit(1);
  '

if find "$root" -type f \( -name '*.tmp-*' -o -name '*.tmp' \) -print -quit | grep -q .; then
  echo "temporary backup status file remains" >&2
  exit 1
fi

echo ok
