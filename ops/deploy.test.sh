#!/bin/sh
set -eu

self="$(CDPATH= cd -- "$(dirname "$0")" && pwd)/$(basename "$0")"

mock_git() {
  case "$1" in
    branch) printf 'main\n' ;;
    status) [ "${MOCK_GIT_DIRTY:-0}" = 1 ] && printf '?? unexpected.txt\n' || true ;;
    fetch) exit 0 ;;
    rev-parse)
      case "$2" in HEAD|origin/main) printf '%s\n' "$MOCK_SHA" ;; *) exit 2 ;; esac
      ;;
    *) exit 2 ;;
  esac
}

mock_docker() {
  case "$1" in
    build)
      : > "$MOCK_ROOT/build-started"
      printf '%s\n' "$*" >> "$MOCK_ROOT/mock.log"
      if [ "${MOCK_DELAY:-0}" = 1 ]; then sleep 2; fi
      ;;
    compose)
      shift
      if [ "$1" = "--profile" ]; then
        cp -p "$MOCK_ROOT/data/bot.sqlite" "$MOCK_ROOT/backups/bot-20260802T000000Z.sqlite"
        printf '/backups/bot-20260802T000000Z.sqlite\n'
        exit 0
      fi
      case "$1" in
        ps) printf 'mock-%s\n' "$3" ;;
        config|pull|up|stop) exit 0 ;;
        *) exit 2 ;;
      esac
      ;;
    inspect)
      case "$*" in
        *RestartCount*) printf '0\n'; exit 0 ;;
      esac
      count="$(cat "$MOCK_ROOT/inspect-count")"
      count=$((count + 1))
      printf '%s\n' "$count" > "$MOCK_ROOT/inspect-count"
      if [ "$MOCK_MODE" = fail-once ] && [ "$count" -eq 2 ]; then
        printf 'unhealthy\n'
      else
        printf 'healthy\n'
      fi
      ;;
    image)
      exit 0
      ;;
    *) exit 2 ;;
  esac
}

case "$(basename "$0")" in
  mock-git) mock_git "$@"; exit ;;
  mock-docker) mock_docker "$@"; exit ;;
esac

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
mkdir -p "$test_root/data" "$test_root/backups" "$test_root/state"
ln -s "$self" "$test_root/mock-git"
ln -s "$self" "$test_root/mock-docker"

sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
current='miyabi-bot:git-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
candidate="miyabi-bot:git-$sha"

write_env() {
  printf 'DISCORD_TOKEN=test\nBOT_IMAGE=%s\nBOT_IMAGE_PREVIOUS=%s\n' "$current" "$current" > "$test_root/.env"
  chmod 600 "$test_root/.env"
}

run_deploy() {
  MOCK_ROOT="$test_root" MOCK_SHA="$sha" MOCK_MODE="${MOCK_MODE:-success}" MOCK_DELAY="${MOCK_DELAY:-0}" MOCK_GIT_DIRTY="${MOCK_GIT_DIRTY:-0}" ROOT_DIR="$test_root" STATE_DIR="$test_root/state" GIT_BIN="$test_root/mock-git" DOCKER_BIN="$test_root/mock-docker" HEALTH_ATTEMPTS=1 sh "$(dirname "$self")/deploy.sh"
}

write_env
if MOCK_GIT_DIRTY=1 run_deploy >/dev/null 2>&1; then
  echo 'dirty worktree unexpectedly accepted' >&2
  exit 1
fi

write_env
printf 'lock-test\n' > "$test_root/data/bot.sqlite"
printf '0\n' > "$test_root/inspect-count"
MOCK_DELAY=1 run_deploy > "$test_root/first.log" 2>&1 &
first_pid=$!
while [ ! -f "$test_root/build-started" ]; do sleep 0.05; done
if run_deploy >/dev/null 2>&1; then
  echo 'concurrent deployment unexpectedly accepted' >&2
  exit 1
fi
wait "$first_pid"

write_env
rm -f "$test_root/build-started"
printf 'before-failed-deploy\n' > "$test_root/data/bot.sqlite"
printf '0\n' > "$test_root/inspect-count"
if MOCK_MODE=fail-once run_deploy >/dev/null 2>&1; then
  echo 'failure path unexpectedly succeeded' >&2
  exit 1
fi
grep -qx 'before-failed-deploy' "$test_root/data/bot.sqlite"
grep -qx "BOT_IMAGE=$current" "$test_root/.env"

write_env
printf 'before-successful-deploy\n' > "$test_root/data/bot.sqlite"
printf '0\n' > "$test_root/inspect-count"
run_deploy
grep -qx "BOT_IMAGE=$candidate" "$test_root/.env"
grep -qx "BOT_IMAGE_PREVIOUS=$current" "$test_root/.env"
grep -q "build --build-arg VCS_REF=$sha -t $candidate ." "$test_root/mock.log"
[ "$(stat -c '%a' "$test_root/.env")" = 600 ]

echo ok
