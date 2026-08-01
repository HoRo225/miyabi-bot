#!/bin/sh
set -eu

PROJECT_DIR=${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)
CANDIDATE="candidate-$RELEASE"
ROLLBACK=previous
NODE_IMAGE='node:24-bookworm-slim@sha256:b31e7a42fdf8b8aa5f5ed477c72d694301273f1069c5a2f71d53c6482e99a2fc'
OPS_LOCK_FILE=${OPS_LOCK_FILE:-/tmp/horo-discord-bot-ops.lock}

cd "$PROJECT_DIR"
exec 9>"$OPS_LOCK_FILE"
flock 9
unset NINE_ROUTER_BIND_ADDRESS
mkdir -p backups data
chmod 700 backups data
chmod 600 .env
for file in data/bot.sqlite data/bot.sqlite-wal data/bot.sqlite-shm; do
  [ ! -e "$file" ] || chmod 600 "$file"
done
export BOT_IMAGE_TAG=$CANDIDATE
docker compose config --quiet

if MIYABI_OPS_LOCK_HELD=1 sh ops/bootstrap-9router.sh guard; then
  :
else
  status=$?
  exit "$status"
fi

backup_file=
if [ -f data/bot.sqlite ]; then
  backup_output=$(docker compose --profile ops run --rm --no-deps backup)
  backup_file=$(printf '%s\n' "$backup_output" | tail -n 1)
fi

current_cid=$(docker compose ps -q bot-prod)
if [ -n "$current_cid" ]; then
  previous_image=$(docker inspect --format '{{.Image}}' "$current_cid")
  docker image tag "$previous_image" "horo-discord-bot:$ROLLBACK"
fi

docker run --rm --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /root/.npm:rw,nosuid,nodev,size=64m \
  --mount "type=bind,src=$PROJECT_DIR,dst=/app,readonly" -w /app \
  "$NODE_IMAGE" npm audit --omit=dev
docker compose build bot-prod
docker compose up -d --wait --wait-timeout 180 9router searxng

rollback() {
  docker compose stop bot-prod >/dev/null 2>&1 || true
  if [ "${RESTORE_DB_ON_FAILURE:-0}" = 1 ] && [ -n "$backup_file" ]; then
    rm -f data/bot.sqlite-wal data/bot.sqlite-shm data/bot.sqlite-journal
    cp "backups/$(basename "$backup_file")" data/bot.sqlite
    chmod 600 data/bot.sqlite
  fi
  if [ -n "${previous_image:-}" ]; then
    BOT_IMAGE_TAG=$ROLLBACK docker compose up -d --no-deps --force-recreate bot-prod
  fi
  docker image rm "horo-discord-bot:$CANDIDATE" >/dev/null 2>&1 || true
}
on_signal() {
  trap - 0 HUP INT TERM
  rollback
  exit 1
}
trap rollback 0
trap on_signal HUP INT TERM

docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 bot-prod
docker image tag "horo-discord-bot:$CANDIDATE" "horo-discord-bot:release-$RELEASE"
docker image tag "horo-discord-bot:$CANDIDATE" horo-discord-bot:current
docker image rm "horo-discord-bot:$CANDIDATE" >/dev/null 2>&1 || true
for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' 'horo-discord-bot:release-*'); do
  [ "$image" = "horo-discord-bot:release-$RELEASE" ] || docker image rm "$image" >/dev/null 2>&1 || true
done
trap - 0 HUP INT TERM
printf 'deployed=%s backup=%s\n' "$RELEASE" "$backup_file"
