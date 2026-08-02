#!/bin/sh
set -eu

self="$(CDPATH= cd -- "$(dirname "$0")" && pwd)/$(basename "$0")"

mock_log() {
  printf '%s\n' "$*" >> "$MOCK_ROOT/mock.log"
}

mock_git() {
  case "$1" in
    branch) printf '%s\n' "${MOCK_BRANCH:-main}" ;;
    status) [ "${MOCK_GIT_DIRTY:-0}" = 1 ] && printf '?? unexpected.txt\n' || true ;;
    fetch) exit 0 ;;
    rev-parse)
      case "$2" in
        HEAD) printf '%s\n' "$MOCK_HEAD_SHA" ;;
        origin/main) printf '%s\n' "$MOCK_REMOTE_SHA" ;;
        *) exit 2 ;;
      esac
      ;;
    *) exit 2 ;;
  esac
}

mock_mv() {
  [ "${MOCK_MV_FAIL:-0}" = 0 ] || exit 1
  exec /bin/mv "$@"
}

mock_docker() {
  case "$1" in
    build)
      mock_log "build $*"
      : > "$MOCK_ROOT/build-started"
      [ "${MOCK_DELAY:-0}" = 0 ] || sleep 2
      ;;
    compose)
      shift
      if [ "$1" = "--profile" ]; then
        mock_log backup
        cp -p "$MOCK_ROOT/data/bot.sqlite" "$MOCK_ROOT/backups/bot-20260802T000000Z.sqlite"
        printf '/backups/bot-20260802T000000Z.sqlite\n'
        exit 0
      fi
      case "$1" in
        ps)
          printf 'mock-%s\n' "$3"
          ;;
        config|pull)
          mock_log "$1 image=${BOT_IMAGE:-unset}"
          ;;
        up)
          mock_log "up image=${BOT_IMAGE:-unset}"
          printf '%s\n' "${BOT_IMAGE:-}" > "$MOCK_ROOT/active-image"
          if [ "${BOT_IMAGE:-}" = "$MOCK_CURRENT" ] && [ -n "${MOCK_EXPECT_DB:-}" ]; then
            grep -qx "$MOCK_EXPECT_DB" "$MOCK_ROOT/data/bot.sqlite" || {
              mock_log rollback-before-database
              exit 1
            }
          fi
          ;;
        stop)
          mock_log "stop $*"
          ;;
        *) exit 2 ;;
      esac
      ;;
    inspect)
      case "$*" in
        *RestartCount*) printf '0\n'; exit 0 ;;
      esac
      id=
      for arg in "$@"; do id="$arg"; done
      case "$id" in
        *9router*) printf 'healthy\n'; exit 0 ;;
      esac
      active="$(cat "$MOCK_ROOT/active-image")"
      case "${MOCK_MODE:-success}:$active" in
        candidate-fail:"$MOCK_CANDIDATE"|both-fail:"$MOCK_CANDIDATE"|both-fail:"$MOCK_CURRENT")
          printf 'unhealthy\n'
          ;;
        *) printf 'healthy\n' ;;
      esac
      ;;
    image)
      case "$2" in
        ls) printf '%s\n' "$MOCK_CANDIDATE" "$MOCK_CURRENT" "$MOCK_STALE" ;;
        rm) mock_log "image rm $3" ;;
        *) exit 2 ;;
      esac
      ;;
    *) exit 2 ;;
  esac
}

case "$(basename "$0")" in
  mock-git) mock_git "$@"; exit ;;
  mock-docker) mock_docker "$@"; exit ;;
  mv) mock_mv "$@"; exit ;;
esac

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
mkdir -p "$test_root/data" "$test_root/backups" "$test_root/state"
ln -s "$self" "$test_root/mock-git"
ln -s "$self" "$test_root/mock-docker"
ln -s "$self" "$test_root/mv"

sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
other_sha='cccccccccccccccccccccccccccccccccccccccc'
current='miyabi-bot:git-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
candidate="miyabi-bot:git-$sha"
stale='miyabi-bot:git-dddddddddddddddddddddddddddddddddddddddd'

write_env() {
  image="${1:-$current}"
  printf 'DISCORD_TOKEN=test\nBOT_IMAGE=%s\nBOT_IMAGE_PREVIOUS=%s\n' "$image" "$current" > "$test_root/.env"
  chmod 600 "$test_root/.env"
}

reset_case() {
  rm -f "$test_root/build-started" "$test_root/mock.log"
  : > "$test_root/mock.log"
  printf '%s\n' "$current" > "$test_root/active-image"
  rm -f "$test_root"/.env.tmp.*
}

run_deploy() {
  PATH="$test_root:$PATH" \
  MOCK_ROOT="$test_root" \
  MOCK_HEAD_SHA="${MOCK_HEAD_SHA:-$sha}" \
  MOCK_REMOTE_SHA="${MOCK_REMOTE_SHA:-$sha}" \
  MOCK_BRANCH="${MOCK_BRANCH:-main}" \
  MOCK_GIT_DIRTY="${MOCK_GIT_DIRTY:-0}" \
  MOCK_DELAY="${MOCK_DELAY:-0}" \
  MOCK_MODE="${MOCK_MODE:-success}" \
  MOCK_MV_FAIL="${MOCK_MV_FAIL:-0}" \
  MOCK_CURRENT="$current" \
  MOCK_CANDIDATE="$candidate" \
  MOCK_STALE="$stale" \
  MOCK_EXPECT_DB="${MOCK_EXPECT_DB:-}" \
  ROOT_DIR="$test_root" \
  STATE_DIR="$test_root/state" \
  GIT_BIN="$test_root/mock-git" \
  DOCKER_BIN="$test_root/mock-docker" \
  HEALTH_ATTEMPTS=1 \
  sh "$(dirname "$self")/deploy.sh"
}

assert_rejected_before_build() {
  [ ! -e "$test_root/build-started" ] || {
    echo "rejected deployment started a build" >&2
    exit 1
  }
}

assert_no_env_temp() {
  for path in "$test_root"/.env.tmp.*; do
    [ ! -e "$path" ] || { echo "temporary env remains" >&2; exit 1; }
  done
}

line_of() {
  awk -v expected="$1" '$0 == expected { print NR; exit }' "$test_root/mock.log"
}

write_env
reset_case
if MOCK_GIT_DIRTY=1 run_deploy >/dev/null 2>&1; then
  echo "dirty worktree unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
if MOCK_BRANCH=feature run_deploy >/dev/null 2>&1; then
  echo "non-main branch unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
if MOCK_REMOTE_SHA="$other_sha" run_deploy >/dev/null 2>&1; then
  echo "stale main unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env 'invalid:latest'
reset_case
if run_deploy >/dev/null 2>&1; then
  echo "invalid image unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
printf 'lock-test\n' > "$test_root/data/bot.sqlite"
MOCK_DELAY=1 run_deploy > "$test_root/first.log" 2>&1 &
first_pid=$!
attempts=0
while [ ! -f "$test_root/build-started" ]; do
  if ! kill -0 "$first_pid" 2>/dev/null; then
    wait "$first_pid" || true
    cat "$test_root/first.log" >&2
    echo "lock test deployment exited before build" >&2
    exit 1
  fi
  attempts=$((attempts + 1))
  [ "$attempts" -lt 100 ] || { echo "lock test build timed out" >&2; exit 1; }
  sleep 0.05
done
if run_deploy >/dev/null 2>&1; then
  echo "concurrent deployment unexpectedly accepted" >&2
  exit 1
fi
wait "$first_pid"

write_env
reset_case
printf 'before-candidate-fail\n' > "$test_root/data/bot.sqlite"
if MOCK_MODE=candidate-fail MOCK_EXPECT_DB=before-candidate-fail run_deploy >/dev/null 2>&1; then
  echo "candidate failure unexpectedly succeeded" >&2
  exit 1
fi
grep -qx 'before-candidate-fail' "$test_root/data/bot.sqlite"
grep -qx "BOT_IMAGE=$current" "$test_root/.env"
[ "$(grep -c '^backup$' "$test_root/mock.log")" -eq 1 ]
backup_line="$(line_of backup)"
candidate_line="$(line_of "up image=$candidate")"
current_line="$(line_of "up image=$current")"
[ "$backup_line" -lt "$candidate_line" ]
[ "$candidate_line" -lt "$current_line" ]
assert_no_env_temp

write_env
reset_case
printf 'before-mv-fail\n' > "$test_root/data/bot.sqlite"
if MOCK_MV_FAIL=1 MOCK_EXPECT_DB=before-mv-fail run_deploy >/dev/null 2>&1; then
  echo "env replacement failure unexpectedly succeeded" >&2
  exit 1
fi
grep -qx 'before-mv-fail' "$test_root/data/bot.sqlite"
grep -qx "BOT_IMAGE=$current" "$test_root/.env"
[ "$(stat -c '%a' "$test_root/.env")" = 600 ]
[ "$(cat "$test_root/active-image")" = "$current" ]
candidate_line="$(line_of "up image=$candidate")"
current_line="$(line_of "up image=$current")"
[ -n "$candidate_line" ] && [ -n "$current_line" ]
[ "$candidate_line" -lt "$current_line" ]
assert_no_env_temp

write_env
reset_case
printf 'before-both-fail\n' > "$test_root/data/bot.sqlite"
if MOCK_MODE=both-fail MOCK_EXPECT_DB=before-both-fail run_deploy >/dev/null 2>&1; then
  echo "double health failure unexpectedly succeeded" >&2
  exit 1
fi
grep -qx 'before-both-fail' "$test_root/data/bot.sqlite"
grep -qx "BOT_IMAGE=$current" "$test_root/.env"
[ "$(grep -c '^backup$' "$test_root/mock.log")" -eq 1 ]
[ "$(grep -c '^stop stop bot-prod$' "$test_root/mock.log")" -ge 2 ]
assert_no_env_temp

write_env
reset_case
printf 'before-success\n' > "$test_root/data/bot.sqlite"
run_deploy >/dev/null
grep -qx "BOT_IMAGE=$candidate" "$test_root/.env"
grep -qx "BOT_IMAGE_PREVIOUS=$current" "$test_root/.env"
grep -q "build --build-arg VCS_REF=$sha -t $candidate ." "$test_root/mock.log"
[ "$(stat -c '%a' "$test_root/.env")" = 600 ]
backup_line="$(line_of backup)"
candidate_line="$(line_of "up image=$candidate")"
[ "$backup_line" -lt "$candidate_line" ]
grep -qx "image rm $stale" "$test_root/mock.log"
! grep -qx "image rm $current" "$test_root/mock.log"
! grep -qx "image rm $candidate" "$test_root/mock.log"
assert_no_env_temp

echo ok
