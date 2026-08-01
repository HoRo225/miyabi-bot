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
mkdir -p "$data_dir" "$backup_dir" "$bad_dir" "$readonly_dir"
user="$(id -u):$(id -g)"

"$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" -v "$data_dir:/app/data" "$image" node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync("/app/data/bot.sqlite");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1);");
  db.close();
'

source_hash="$(sha256sum "$data_dir/bot.sqlite" | awk '{print $1}')"
for stamp in 20260101T000001Z 20260101T000002Z 20260101T000003Z 20260101T000004Z 20260101T000005Z; do
  touch "$backup_dir/bot-$stamp.sqlite"
done

output="$("$docker_bin" run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --user "$user" -e DATABASE_PATH=/app/data/bot.sqlite -e BACKUP_DIR=/backups -e BACKUP_KEEP=5 -v "$data_dir:/app/data:ro" -v "$backup_dir:/backups" "$image" node /app/ops/backup.mjs)"
backup_name="$(printf '%s\n' "$output" | tail -n 1 | sed 's#^/backups/##')"
case "$backup_name" in bot-[0-9]*T[0-9]*Z.sqlite) ;; *) echo "invalid backup output" >&2; exit 1 ;; esac
[ -f "$backup_dir/$backup_name" ]
[ "$(stat -c '%a' "$backup_dir/$backup_name")" = 600 ]
[ "$(sha256sum "$data_dir/bot.sqlite" | awk '{print $1}')" = "$source_hash" ]

count=0
for path in "$backup_dir"/bot-*.sqlite; do
  [ -e "$path" ] || continue
  count=$((count + 1))
done
[ "$count" -eq 5 ]

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

if "$docker_bin" run --rm --network none --read-only --user "$user" -e DATABASE_PATH=/app/data/missing.sqlite -e BACKUP_DIR=/backups -v "$data_dir:/app/data:ro" -v "$bad_dir:/backups" "$image" node /app/ops/backup.mjs >/dev/null 2>&1; then
  echo "missing source unexpectedly backed up" >&2
  exit 1
fi
[ -z "$(ls -A "$bad_dir")" ]

if "$docker_bin" run --rm --network none --read-only --user "$user" -e DATABASE_PATH=/app/data/bot.sqlite -e BACKUP_DIR=/backups -v "$data_dir:/app/data:ro" -v "$readonly_dir:/backups:ro" "$image" node /app/ops/backup.mjs >/dev/null 2>&1; then
  echo "read-only target unexpectedly accepted" >&2
  exit 1
fi
[ -z "$(ls -A "$readonly_dir")" ]

echo ok
