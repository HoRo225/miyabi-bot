#!/bin/sh
set -eu
umask 077

root_dir="${ROOT_DIR:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}"
docker_bin="${DOCKER_BIN:-docker}"
git_bin="${GIT_BIN:-git}"
state_dir="${STATE_DIR:-$HOME/.local/state}"
mkdir -p "$state_dir"
exec 9>"$state_dir/miyabi-deploy.lock"
flock -n 9 || { echo "deployment already running" >&2; exit 1; }
env_snapshot=
env_temp=

cleanup() {
  [ -z "$env_snapshot" ] || rm -f "$env_snapshot"
  [ -z "$env_temp" ] || rm -f "$env_temp"
}
trap cleanup EXIT

[ "$#" -eq 0 ] || { echo "usage: deploy.sh" >&2; exit 2; }
cd "$root_dir"

compose() {
  "$docker_bin" compose "$@"
}

env_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env
}

valid_sha() {
  [ "${#1}" -eq 40 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

valid_image() {
  case "$1" in miyabi-bot:git-*) sha="${1#miyabi-bot:git-}" ;; *) return 1 ;; esac
  valid_sha "$sha"
}

wait_healthy() {
  service="$1"
  attempts="${HEALTH_ATTEMPTS:-120}"
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

restart_count() {
  id="$(compose ps -q "$1")"
  [ -n "$id" ] || { printf 'absent'; return; }
  "$docker_bin" inspect --format '{{.RestartCount}}' "$id" 2>/dev/null || printf 'unknown'
}

backup_db() {
  image="$1"
  mkdir -p backups
  output="$(BOT_IMAGE="$image" compose --profile ops run --rm --no-deps -T backup)"
  name="$(printf '%s\n' "$output" | tail -n 1 | sed 's#^/backups/##')"
  case "$name" in bot-[0-9]*T[0-9]*Z.sqlite) ;; *) echo "invalid backup output" >&2; return 1 ;; esac
  path="$root_dir/backups/$name"
  [ -f "$path" ] || { echo "backup not found" >&2; return 1; }
  printf '%s\n' "$path"
}

restore_db() {
  backup_path="$1"
  case "$backup_path" in "$root_dir"/backups/bot-*.sqlite) ;; *) echo "invalid backup path" >&2; return 1 ;; esac
  [ -f "$backup_path" ] || { echo "backup not found" >&2; return 1; }
  compose stop bot-prod >/dev/null 2>&1 || true
  rm -f data/bot.sqlite-wal data/bot.sqlite-shm
  cp -p "$backup_path" data/bot.sqlite &&
    chmod 600 data/bot.sqlite
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
env_snapshot="$(mktemp "$state_dir/miyabi-env.XXXXXX")"
cp -p .env "$env_snapshot"

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
cp -p "$env_snapshot" .env
if ! apply_image "$current"; then
  compose stop bot-prod >/dev/null 2>&1 || true
  echo "rollback image is unhealthy; bot stopped" >&2
fi
"$docker_bin" image rm "$candidate" >/dev/null 2>&1 || true
exit 1
