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
        if [ "${MOCK_BACKUP_SYMLINK:-0}" = 1 ]; then
          printf 'backup-outside\n' > "$MOCK_ROOT/backup-outside.sqlite"
          ln -sf "$MOCK_ROOT/backup-outside.sqlite" "$MOCK_ROOT/backups/bot-20260802T000000Z.sqlite"
        else
          cp -p "$MOCK_ROOT/data/bot.sqlite" "$MOCK_ROOT/backups/bot-20260802T000000Z.sqlite"
          chmod 600 "$MOCK_ROOT/backups/bot-20260802T000000Z.sqlite"
        fi
        printf '/backups/bot-20260802T000000Z.sqlite\n'
        exit 0
      fi
      case "$1" in
        ps)
          if [ "$3" = 9router ] && [ "${MOCK_ROUTER_CONTAINER:-1}" != 1 ]; then
            exit 0
          fi
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
        *Config.Image*)
          printf '%s\n' "${MOCK_ROUTER_REF:-decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9}"
          exit 0
          ;;
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
    run)
      mock_log "run db-check $*"
      [ "${MOCK_DB_CHECK_FAIL:-0}" = 1 ] && exit 1
      exit 0
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
cat > "$test_root/docker-compose.yml" <<'YAML'
services:
  9router:
    image: decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9
YAML
cp "$test_root/docker-compose.yml" "$test_root/docker-compose.yml.base"
ln -s "$self" "$test_root/mock-git"
ln -s "$self" "$test_root/mock-docker"
ln -s "$self" "$test_root/mv"

sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
other_sha='cccccccccccccccccccccccccccccccccccccccc'
current='miyabi-bot:git-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
candidate="miyabi-bot:git-$sha"
stale='miyabi-bot:git-dddddddddddddddddddddddddddddddddddddddd'
test_runtime_uid="$(id -u)"
test_runtime_gid="$(id -g)"

write_env() {
  image="${1:-$current}"
  printf 'DISCORD_TOKEN=test\nBOT_IMAGE=%s\nBOT_IMAGE_PREVIOUS=%s\n' "$image" "$current" > "$test_root/.env"
  chmod 600 "$test_root/.env"
}

reset_case() {
  unset MOCK_BACKUP_SYMLINK MOCK_DB_CHECK_FAIL MOCK_DELAY MOCK_MODE MOCK_MV_FAIL MOCK_ROUTER_CONTAINER MOCK_ROUTER_REF MOCK_GIT_DIRTY MOCK_BRANCH MOCK_REMOTE_SHA MOCK_EXPECT_DB HEALTH_ATTEMPTS RUNTIME_UID RUNTIME_GID
  rm -rf "$test_root/state"
  mkdir -p "$test_root/state"
  rm -f "$test_root/build-started" "$test_root/mock.log"
  rm -rf "$test_root/data/status"
  cp "$test_root/docker-compose.yml.base" "$test_root/docker-compose.yml"
  rm -rf "$test_root/backups"
  mkdir -p "$test_root/backups"
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
  MOCK_ROUTER_CONTAINER="${MOCK_ROUTER_CONTAINER:-1}" \
  MOCK_ROUTER_REF="${MOCK_ROUTER_REF:-decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9}" \
  MOCK_BACKUP_SYMLINK="${MOCK_BACKUP_SYMLINK:-0}" \
  MOCK_DB_CHECK_FAIL="${MOCK_DB_CHECK_FAIL:-0}" \
  MOCK_EXPECT_DB="${MOCK_EXPECT_DB:-}" \
  RUNTIME_UID="${RUNTIME_UID-$test_runtime_uid}" \
  RUNTIME_GID="${RUNTIME_GID-$test_runtime_gid}" \
  ROOT_DIR="$test_root" \
  STATE_DIR="$test_root/state" \
  OPS_LOCK_FILE="$test_root/deploy.lock" \
  GIT_BIN="$test_root/mock-git" \
  DOCKER_BIN="$test_root/mock-docker" \
  HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-1}" \
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

assert_status_dir() {
  [ -d "$test_root/data/status" ] || { echo "status directory missing" >&2; exit 1; }
  [ "$(stat -c '%a' "$test_root/data/status")" = 700 ] || { echo "status directory mode is not 700" >&2; exit 1; }
  [ "$(stat -c '%u:%g' "$test_root/data/status")" = "$test_runtime_uid:$test_runtime_gid" ] || { echo "status directory owner is not runtime uid/gid" >&2; exit 1; }
}

line_of() {
  awk -v expected="$1" '$0 == expected { print NR; exit }' "$test_root/mock.log"
}

write_release_state() {
  mkdir -p "$test_root/data/status"
  printf 'state=%s\n' "$1" > "$test_root/data/status/router-release.manifest"
  chmod 600 "$test_root/data/status/router-release.manifest"
}

for release_state in preparing prepared validated finalizing cutover failed rolled_back; do
  write_env
  reset_case
  write_release_state "$release_state"
  if run_deploy >/dev/null 2>&1; then
    echo "router release state $release_state unexpectedly accepted" >&2
    exit 1
  fi
  assert_rejected_before_build
done

write_env
reset_case
rm -rf "$test_root/state"
printf 'state-create\n' > "$test_root/data/bot.sqlite"
run_deploy >/dev/null
[ -d "$test_root/state" ] || { echo "missing state directory was not created" >&2; exit 1; }
[ "$(stat -c '%a' "$test_root/state")" = 700 ] || { echo "created state directory mode is not 700" >&2; exit 1; }

write_env
reset_case
rm -rf "$test_root/state"
mkdir -p "$test_root/state-target"
printf 'state-referent-sentinel\n' > "$test_root/state-target/sentinel"
ln -s "$test_root/state-target" "$test_root/state"
if run_deploy >/dev/null 2>&1; then
  echo "symlink state directory unexpectedly accepted" >&2
  exit 1
fi
grep -Fxq 'state-referent-sentinel' "$test_root/state-target/sentinel"
assert_rejected_before_build

write_env
reset_case
rm -rf "$test_root/state"
printf 'state-file-sentinel\n' > "$test_root/state"
if run_deploy >/dev/null 2>&1; then
  echo "non-directory state path unexpectedly accepted" >&2
  exit 1
fi
grep -Fxq 'state-file-sentinel' "$test_root/state"
assert_rejected_before_build

write_env
reset_case
mkdir -p "$test_root/data/status"
ln -s "$test_root/data/status/missing-target" "$test_root/data/status/router-release.manifest"
if run_deploy >/dev/null 2>&1; then
  echo "broken router release manifest symlink unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
mkdir -p "$test_root/data/status/router-release.manifest"
if run_deploy >/dev/null 2>&1; then
  echo "non-regular router release manifest unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
mkdir -p "$test_root/data/status"
printf 'state=none\n' > "$test_root/data/status/router-release.manifest"
chmod 644 "$test_root/data/status/router-release.manifest"
if run_deploy >/dev/null 2>&1; then
  echo "world-readable router release manifest unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
if MOCK_ROUTER_CONTAINER=0 run_deploy >/dev/null 2>&1; then
  echo "missing running router unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
if MOCK_ROUTER_REF='decolua/9router:0.5.12@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' run_deploy >/dev/null 2>&1; then
  echo "router image ref mismatch unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
sed -i 's#decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9#decolua/9router:latest#' "$test_root/docker-compose.yml"
if MOCK_ROUTER_REF=decolua/9router:latest run_deploy >/dev/null 2>&1; then
  echo "floating router image ref unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

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

write_env
reset_case
if HEALTH_ATTEMPTS=not-a-number run_deploy >/dev/null 2>&1; then
  echo "non-decimal health attempts unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
if HEALTH_ATTEMPTS=301 run_deploy >/dev/null 2>&1; then
  echo "unbounded health attempts unexpectedly accepted" >&2
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
if RUNTIME_UID=not-a-number run_deploy >/dev/null 2>&1; then
  echo "invalid runtime uid override unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
if RUNTIME_GID=not-a-number run_deploy >/dev/null 2>&1; then
  echo "invalid runtime gid override unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
if RUNTIME_UID= RUNTIME_GID="$test_runtime_gid" run_deploy >/dev/null 2>&1; then
  echo "empty runtime uid override unexpectedly accepted" >&2
  exit 1
fi
assert_rejected_before_build

write_env
reset_case
printf 'backup-symlink\n' > "$test_root/data/bot.sqlite"
if MOCK_BACKUP_SYMLINK=1 run_deploy >/dev/null 2>&1; then
  echo "backup symlink unexpectedly accepted" >&2
  exit 1
fi
[ "$(cat "$test_root/active-image")" = "$current" ]

write_env
reset_case
printf 'backup-integrity\n' > "$test_root/data/bot.sqlite"
if MOCK_DB_CHECK_FAIL=1 run_deploy >/dev/null 2>&1; then
  echo "backup integrity failure unexpectedly accepted" >&2
  exit 1
fi
[ "$(cat "$test_root/active-image")" = "$current" ]

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
wait "$first_pid" || { cat "$test_root/first.log" >&2; cat "$test_root/mock.log" >&2; echo "lock test first deployment failed" >&2; exit 1; }

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
assert_status_dir
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
