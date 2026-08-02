#!/bin/sh
set -eu
umask 077

root_dir="${ROOT_DIR:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}"
docker_bin="${DOCKER_BIN:-docker}"
git_bin="${GIT_BIN:-git}"
state_dir="${STATE_DIR:-$HOME/.local/state}"
ops_lock_file="${OPS_LOCK_FILE:-/tmp/horo-discord-bot-ops.lock}"
pinned_router_ref='decolua/9router@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9'
mkdir -p "$(dirname "$ops_lock_file")"
exec 9>"$ops_lock_file"
flock -n 9 || { echo "deployment already running" >&2; exit 1; }
env_snapshot=
env_temp=
if [ "${RUNTIME_UID+x}" != "${RUNTIME_GID+x}" ]; then
  echo "runtime uid/gid overrides must be provided together" >&2
  exit 1
fi
runtime_uid="${RUNTIME_UID-1000}"
runtime_gid="${RUNTIME_GID-1000}"

case "$runtime_uid" in
  ''|*[!0-9]*) echo "runtime uid override must be a non-empty decimal" >&2; exit 1 ;;
esac
case "$runtime_gid" in
  ''|*[!0-9]*) echo "runtime gid override must be a non-empty decimal" >&2; exit 1 ;;
esac

cleanup() {
  [ -z "$env_snapshot" ] || rm -f "$env_snapshot"
  [ -z "$env_temp" ] || rm -f "$env_temp"
}
trap cleanup EXIT

[ "$#" -eq 0 ] || { echo "usage: deploy.sh" >&2; exit 2; }
cd "$root_dir"

prepare_state_dir() {
  [ ! -L "$state_dir" ] || { echo 'state directory must not be a symlink' >&2; return 1; }
  if [ -e "$state_dir" ] && [ ! -d "$state_dir" ]; then
    echo 'state directory must be a directory' >&2
    return 1
  fi
  mkdir -p "$state_dir" || return 1
  [ ! -L "$state_dir" ] || { echo 'state directory must not be a symlink' >&2; return 1; }
  chmod 700 "$state_dir" || return 1
  [ "$(stat -c '%a' "$state_dir" 2>/dev/null || printf 0)" = 700 ] || {
    echo 'state directory must be mode 700' >&2
    return 1
  }
}

prepare_state_dir

prepare_status_dir() {
  status_dir="$root_dir/data/status"
  [ ! -L "$status_dir" ] || { echo "data/status must not be a symlink" >&2; return 1; }
  mkdir -p "$status_dir"
  chmod 700 "$status_dir"
  if [ "$(id -u)" -ne "$runtime_uid" ] || [ "$(id -g)" -ne "$runtime_gid" ]; then
    chown "$runtime_uid:$runtime_gid" "$status_dir" || {
      echo "data/status owner must match runtime uid/gid" >&2
      return 1
    }
  fi
  [ "$(stat -c '%u:%g' "$status_dir")" = "$runtime_uid:$runtime_gid" ] || {
    echo "data/status owner must match runtime uid/gid" >&2
    return 1
  }
}

prepare_status_dir

compose() {
  "$docker_bin" compose "$@"
}

env_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env
}

router_release_manifest="${ROUTER_RELEASE_MANIFEST:-$root_dir/data/status/router-release.manifest}"
router_release_state() {
  [ ! -L "$router_release_manifest" ] || { echo 'router release manifest must not be symlink' >&2; exit 1; }
  if [ -e "$router_release_manifest" ] && [ ! -f "$router_release_manifest" ]; then
    echo 'router release manifest must be a regular file' >&2
    exit 1
  fi
  [ -f "$router_release_manifest" ] || { printf 'none'; return; }
  mode=$(stat -c '%a' "$router_release_manifest" 2>/dev/null) || { echo 'router release manifest stat failed' >&2; exit 1; }
  [ "$mode" = 600 ] || { echo 'router release manifest must be mode 600' >&2; exit 1; }
  [ -r "$router_release_manifest" ] || { echo 'router release manifest is not readable' >&2; exit 1; }
  state_value=$(awk -F= '$1 == "state" { sub(/^[^=]*=/, ""); print; exit }' "$router_release_manifest") || {
    echo 'router release manifest read failed' >&2
    exit 1
  }
  printf '%s' "$state_value"
}

router_image_from_compose() {
  sed -n 's/^[[:space:]]*image:[[:space:]]*//p' docker-compose.yml |
    sed -n '/decolua\/9router[@:]/p' | head -n 1
}

router_ref_pinned() {
  case "$1" in
    decolua/9router@sha256:*|decolua/9router:*@sha256:*) digest=${1##*@sha256:};;
    *) return 1;;
  esac
  [ "${#digest}" -eq 64 ] || return 1
  case "$digest" in *[!0-9a-f]*) return 1;; esac
}

assert_router_release_ready() {
  release_state="$(router_release_state)"
  case "$release_state" in none) ;; *) echo "router release state $release_state requires router-release rollback/finalize" >&2; return 1;; esac
  [ -f docker-compose.yml ] || { echo 'docker-compose.yml missing' >&2; return 1; }
  target_router="$(router_image_from_compose)"
  router_ref_pinned "$target_router" || { echo 'router image must be digest pinned' >&2; return 1; }
  [ "$target_router" = "$pinned_router_ref" ] || { echo 'router image must use the fixed digest-only ref' >&2; return 1; }
  router_id="$(compose ps -q 9router 2>/dev/null || true)"
  [ -n "$router_id" ] || { echo 'running router container missing' >&2; return 1; }
  running_router="$($docker_bin inspect --format '{{.Config.Image}}' "$router_id" 2>/dev/null || true)"
  [ -n "$running_router" ] || { echo 'running router image inspect failed' >&2; return 1; }
  [ "$running_router" = "$target_router" ] || { echo "running router ref differs from compose: $running_router" >&2; return 1; }
}

assert_router_release_ready

valid_sha() {
  [ "${#1}" -eq 40 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

valid_image() {
  case "$1" in miyabi-bot:git-*) sha="${1#miyabi-bot:git-}" ;; *) return 1 ;; esac
  valid_sha "$sha"
}

valid_hash256() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

health_attempts="${HEALTH_ATTEMPTS:-120}"
case "$health_attempts" in ''|*[!0-9]*) echo 'HEALTH_ATTEMPTS must be a decimal' >&2; exit 1;; esac
[ "$health_attempts" -ge 1 ] 2>/dev/null && [ "$health_attempts" -le 300 ] 2>/dev/null || {
  echo 'HEALTH_ATTEMPTS must be between 1 and 300' >&2
  exit 1
}

wait_healthy() {
  service="$1"
  attempts="$health_attempts"
  count=0
  while [ "$count" -lt "$attempts" ]; do
    id="$(compose ps -q "$service")"
    if [ -n "$id" ]; then
      status="$("$docker_bin" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [ "$status" = healthy ] && return 0
    fi
    count=$((count + 1))
    sleep 2
  done
  return 1
}

check_database_file() {
  image="$1"
  database_file="$2"
  [ -f "$database_file" ] || return 1
  [ ! -L "$database_file" ] || return 1
  "$docker_bin" run --rm --read-only --mount "type=bind,src=$database_file,dst=/data/bot.sqlite,readonly" "$image" node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/bot.sqlite");const i=db.prepare("PRAGMA integrity_check").get().integrity_check;const f=db.prepare("PRAGMA foreign_key_check").all();db.close();if(i!=="ok"||f.length!==0)process.exit(1);'
}

restart_count() {
  id="$(compose ps -q "$1")"
  [ -n "$id" ] || { printf 'absent'; return; }
  "$docker_bin" inspect --format '{{.RestartCount}}' "$id" 2>/dev/null || printf 'unknown'
}

backup_db() {
  image="$1"
  mkdir -p backups
  [ ! -L "$root_dir/backups" ] || { echo 'backups directory must not be symlink' >&2; return 1; }
  output="$(BOT_IMAGE="$image" compose --profile ops run --rm --no-deps -T backup)"
  name="$(printf '%s\n' "$output" | tail -n 1 | sed 's#^/backups/##')"
  case "$name" in bot-[0-9]*T[0-9]*Z.sqlite) ;; *) echo "invalid backup output" >&2; return 1 ;; esac
  path="$root_dir/backups/$name"
  [ -f "$path" ] || { echo "backup not found" >&2; return 1; }
  [ ! -L "$path" ] || { echo 'backup must not be symlink' >&2; return 1; }
  [ "$(stat -c '%a' "$path" 2>/dev/null || printf 0)" = 600 ] || { echo 'backup must be mode 600' >&2; return 1; }
  backup_hash_candidate=$(sha256sum "$path" 2>/dev/null | awk '{print $1}')
  valid_hash256 "$backup_hash_candidate" || { echo 'backup hash invalid' >&2; return 1; }
  check_database_file "$image" "$path" || { echo 'backup integrity check failed' >&2; return 1; }
  printf '%s\n' "$path"
}

restore_db() {
  backup_path="$1"
  case "$backup_path" in "$root_dir"/backups/bot-*.sqlite) ;; *) echo "invalid backup path" >&2; return 1 ;; esac
  [ -f "$backup_path" ] || { echo "backup not found" >&2; return 1; }
  [ ! -L "$backup_path" ] || { echo 'backup must not be symlink' >&2; return 1; }
  [ "$(stat -c '%a' "$backup_path" 2>/dev/null || printf 0)" = 600 ] || { echo 'backup must be mode 600' >&2; return 1; }
  valid_hash256 "${backup_hash:-}" || { echo 'backup hash missing' >&2; return 1; }
  [ "$(sha256sum "$backup_path" | awk '{print $1}')" = "$backup_hash" ] || { echo 'backup hash mismatch' >&2; return 1; }
  compose stop bot-prod >/dev/null 2>&1 || true
  rm -f data/bot.sqlite-wal data/bot.sqlite-shm
  [ ! -L data/bot.sqlite ] || { echo 'database target must not be symlink' >&2; return 1; }
  cp -p "$backup_path" data/bot.sqlite && chmod 600 data/bot.sqlite || return 1
  [ "$(stat -c '%a' data/bot.sqlite 2>/dev/null || printf 0)" = 600 ] || return 1
  [ "$(sha256sum data/bot.sqlite | awk '{print $1}')" = "$backup_hash" ] || return 1
  check_database_file "$current" "$root_dir/data/bot.sqlite"
}

apply_image() {
  image="$1"
  BOT_IMAGE="$image" compose config --quiet &&
    BOT_IMAGE="$image" compose pull 9router &&
    BOT_IMAGE="$image" compose up -d --remove-orphans 9router bot-prod &&
    wait_healthy 9router &&
    wait_healthy bot-prod
}

write_images() {
  write_current_image="$1"
  write_previous_image="$2"
  [ ! -L "$root_dir/.env" ] || return 1
  [ -f "$root_dir/.env" ] || return 1
  env_temp="$(mktemp "$root_dir/.env.tmp.XXXXXX")"
  if awk '$0 !~ /^BOT_IMAGE(_PREVIOUS)?=/' .env > "$env_temp" &&
    printf 'BOT_IMAGE=%s\nBOT_IMAGE_PREVIOUS=%s\n' "$write_current_image" "$write_previous_image" >> "$env_temp" &&
    chmod 600 "$env_temp" &&
    mv "$env_temp" .env; then
    env_temp=
    return 0
  fi
  rm -f "$env_temp"
  env_temp=
  return 1
}

cleanup_images() {
  cleanup_current_image="$1"
  cleanup_previous_image="$2"
  "$docker_bin" image ls --format '{{.Repository}}:{{.Tag}}' miyabi-bot |
  while IFS= read -r ref; do
    case "$ref" in "$cleanup_current_image"|"$cleanup_previous_image") continue ;; esac
    if valid_image "$ref"; then
      "$docker_bin" image rm "$ref" >/dev/null 2>&1 || true
    fi
  done
}

branch="$("$git_bin" branch --show-current)"
[ "$branch" = main ] || { echo "deployment requires main" >&2; exit 1; }
[ -z "$("$git_bin" status --porcelain)" ] || { echo "worktree is dirty" >&2; exit 1; }
"$git_bin" fetch --quiet origin main
head="$("$git_bin" rev-parse HEAD)"
remote="$("$git_bin" rev-parse origin/main)"
valid_sha "$head" || { echo "invalid HEAD" >&2; exit 1; }
[ "$head" = "$remote" ] || { echo "main is not up to date" >&2; exit 1; }

candidate="miyabi-bot:git-$head"
[ -f "$root_dir/.env" ] || { echo '.env missing' >&2; exit 1; }
[ ! -L "$root_dir/.env" ] || { echo '.env must not be symlink' >&2; exit 1; }
current="$(env_value BOT_IMAGE)"
valid_image "$current" || { echo "invalid BOT_IMAGE" >&2; exit 1; }
chmod 600 .env

if [ "$current" = "$candidate" ]; then
  BOT_IMAGE="$current" compose config --quiet
  wait_healthy 9router
  wait_healthy bot-prod
  printf 'already deployed %s\n' "$head"
  exit 0
fi

"$docker_bin" build --build-arg "VCS_REF=$head" -t "$candidate" .
backup_path="$(backup_db "$current")"
backup_hash=$(sha256sum "$backup_path" 2>/dev/null | awk '{print $1}')
valid_hash256 "$backup_hash" || { echo 'backup hash invalid' >&2; exit 1; }
env_snapshot="$(mktemp "$state_dir/miyabi-env.XXXXXX")"
cp -p .env "$env_snapshot"
chmod 600 "$env_snapshot"
env_snapshot_hash=$(sha256sum "$env_snapshot" 2>/dev/null | awk '{print $1}')
valid_hash256 "$env_snapshot_hash" || { echo 'environment snapshot hash invalid' >&2; exit 1; }

printf 'before restart-count 9router=%s bot-prod=%s\n' "$(restart_count 9router)" "$(restart_count bot-prod)"
if apply_image "$candidate" && write_images "$candidate" "$current"; then
  cleanup_images "$candidate" "$current"
  printf 'after restart-count 9router=%s bot-prod=%s\n' "$(restart_count 9router)" "$(restart_count bot-prod)"
  printf 'deployed %s\n' "$head"
  exit 0
fi

echo "candidate failed; restoring database, environment and image" >&2
if ! restore_db "$backup_path"; then
  compose stop bot-prod >/dev/null 2>&1 || true
  echo "database rollback failed; bot stopped" >&2
  exit 1
fi
[ ! -L "$root_dir/.env" ] || { compose stop bot-prod >/dev/null 2>&1 || true; echo 'environment file is symlink; bot stopped' >&2; exit 1; }
valid_hash256 "$env_snapshot_hash" || { compose stop bot-prod >/dev/null 2>&1 || true; echo 'environment snapshot hash missing; bot stopped' >&2; exit 1; }
[ "$(sha256sum "$env_snapshot" | awk '{print $1}')" = "$env_snapshot_hash" ] || { compose stop bot-prod >/dev/null 2>&1 || true; echo 'environment snapshot hash mismatch; bot stopped' >&2; exit 1; }
cp -p "$env_snapshot" .env
chmod 600 .env
if ! apply_image "$current"; then
  compose stop bot-prod >/dev/null 2>&1 || true
  echo "rollback image is unhealthy; bot stopped" >&2
fi
"$docker_bin" image rm "$candidate" >/dev/null 2>&1 || true
exit 1
