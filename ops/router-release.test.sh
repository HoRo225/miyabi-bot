#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
release="$script_dir/router-release.sh"
validator="$script_dir/validate-9router-candidate.sh"
compose_file="$script_dir/../docker-compose.yml"

[ -f "$release" ] || { echo "router release script missing" >&2; exit 1; }
[ -f "$validator" ] || { echo "candidate validator missing" >&2; exit 1; }
sh -n "$release" "$validator"
grep -Eq '^[[:space:]]*- "127\.0\.0\.1:20128:20128"$' "$compose_file"
! grep -Eq 'NINE_ROUTER_BIND_ADDRESS|192\.168\.1\.107|0\.0\.0\.0:20128' "$compose_file"

root=$(mktemp -d)
phase=setup
cleanup_test() {
  rc=$?
  trap - EXIT HUP INT TERM
  chmod -R u+w "$root" 2>/dev/null || true
  rm -rf "$root"
  [ "$rc" -eq 0 ] || printf 'router-release.test failure phase=%s status=%s\n' "$phase" "$rc" >&2
  exit "$rc"
}
trap cleanup_test EXIT HUP INT TERM
mkdir -p "$root/bin" "$root/state" "$root/data" "$root/backups" "$root/old-volume"
old_discord='old-discord-token'
old_client='sk-old-client-key'
old_dashboard='old-dashboard-password'
new_discord='new-discord-token'
new_client='sk-new-client-key'
new_dashboard='new-dashboard-password'
old_provider='old-gemini-provider-key'
new_provider='new-gemini-provider-key'
old_router='decolua/9router:0.5.12@sha256:1111111111111111111111111111111111111111111111111111111111111111'
new_router='decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9'
old_volume='horo-discord-bot_9router-data'
new_volume='horo-discord-bot_9router-v0545'
old_bot='miyabi-bot:git-cccccccccccccccccccccccccccccccccccccccc'
new_bot='miyabi-bot:git-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
printf 'DISCORD_TOKEN=%s\nDISCORD_CLIENT_ID=test-client\nDISCORD_GUILD_ID=test-guild\nAI_API_KEY=%s\nNINE_ROUTER_JWT_SECRET=old-jwt\nNINE_ROUTER_API_KEY_SECRET=old-api\nNINE_ROUTER_MACHINE_ID_SALT=old-salt\nBOT_IMAGE=%s\nBOT_IMAGE_PREVIOUS=miyabi-bot:git-cccccccccccccccccccccccccccccccccccccccc\n' "$old_discord" "$old_client" "$old_bot" > "$root/.env"
chmod 600 "$root/.env"
printf 'DISCORD_TOKEN=%s\nGEMINI_API_KEY=%s\nDASHBOARD_PASSWORD=%s\n' "$new_discord" "$new_provider" "$new_dashboard" > "$root/router-secrets"
chmod 600 "$root/router-secrets"
cp "$root/.env" "$root/env.base"
chmod 600 "$root/env.base"
cp "$compose_file" "$root/docker-compose.yml"
cat > "$root/crontab" <<CRON
MAILTO=ops@example.invalid
17 3 * * * /bin/true # keep-this
* * * * * flock -n /tmp/horo-test-ops.lock /bin/backup # miyabi-bot-backup
* * * * * /bin/sync # miyabi-9router-key-sync
CRON
cp "$root/crontab" "$root/crontab.before"
: > "$root/calls.log"
: > "$root/docker.log"
: > "$root/cleanup.log"

cat > "$root/bin/crontab" <<'EOF'
#!/bin/sh
printf 'crontab %s\n' "$*" >> "$MOCK_ROOT/calls.log"
[ "${CRONTAB_FAIL:-0}" = 1 ] && exit 46
case "$1" in
  -l)
    list_count=$(cat "$MOCK_ROOT/crontab-list-count" 2>/dev/null || printf '0\n')
    list_count=$((list_count + 1))
    printf '%s\n' "$list_count" > "$MOCK_ROOT/crontab-list-count"
    [ "${CRONTAB_LIST_FAIL:-0}" = 1 ] && exit 49
    if [ "${CRONTAB_SNAPSHOT_READ_FAIL:-0}" = 1 ] && [ "$list_count" -ge 2 ]; then exit 49; fi
    cat "$MOCK_ROOT/crontab"
    ;;
  -) [ "${CRONTAB_INSTALL_FAIL:-0}" = 1 ] && exit 48; cat > "$MOCK_ROOT/crontab" ;;
  *)
    case "$1" in
      *.paused) [ "${CRONTAB_INSTALL_FAIL:-0}" = 1 ] && exit 48 ;;
      *) [ "${CRONTAB_RESTORE_FAIL:-0}" = 1 ] && exit 47 ;;
    esac
    cat "$1" > "$MOCK_ROOT/crontab"
    ;;
esac
EOF
cat > "$root/bin/git" <<'EOF'
#!/bin/sh
case "$1:$2" in
  rev-parse:HEAD) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
  rev-parse:--verify) printf 'compose-sha\n' ;;
  rev-parse:origin/main) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
  status:--porcelain) ;;
  branch:--show-current) printf 'main\n' ;;
  *) exit 0 ;;
esac
EOF
cat > "$root/bin/docker" <<'EOF'
#!/bin/sh
set -eu
printf 'docker %s\n' "$*" >> "$MOCK_ROOT/docker.log"
for secret in "$MOCK_OLD_DISCORD" "$MOCK_OLD_CLIENT" "$MOCK_OLD_DASHBOARD" "$MOCK_NEW_DISCORD" "$MOCK_NEW_CLIENT" "$MOCK_NEW_DASHBOARD" "$MOCK_OLD_PROVIDER" "$MOCK_NEW_PROVIDER"; do
  case "$*" in *"$secret"*) echo "secret in argv" >&2; exit 97;; esac
done
case "$1" in
  inspect)
    case "$*" in
      *State.Health.Status*) [ "${MOCK_HEALTH_FAIL:-0}" = 1 ] && printf 'unhealthy\n' || printf 'healthy\n' ;;
      *RestartCount*) cat "$MOCK_ROOT/restart-count" 2>/dev/null || printf '0\n' ;;
      *Config.Image*|*Image*) printf '%s\n' "${MOCK_OLD_ROUTER:-}" ;;
      *Mounts*|*Source*|*Name*) printf '%s\n' "${MOCK_OLD_VOLUME:-}" ;;
      *Labels*|*Revision*) printf 'dddddddddddddddddddddddddddddddddddddddd\n' ;;
      *) printf 'healthy\n' ;;
    esac
    ;;
  volume)
    case "$2" in
      inspect)
        if [ "${3:-}" = "${MOCK_NEW_VOLUME:-}" ]; then
          [ -e "$MOCK_ROOT/candidate-created" ] || exit 1
          printf '%s\n' "${3:-}"
        elif [ "${3:-}" = "${MOCK_OLD_VOLUME:-}" ]; then
          printf '%s\n' "${3:-}"
        else
          exit 1
        fi
        ;;
      create)
        : > "$MOCK_ROOT/candidate-created"
        printf '%s\n' "${3:-}"
        ;;
      rm)
        [ "${3:-}" = "${MOCK_NEW_VOLUME:-}" ] && rm -f "$MOCK_ROOT/candidate-created"
        printf 'volume-rm %s\n' "${3:-}" >> "$MOCK_ROOT/calls.log"
        ;;
    esac
    ;;
  compose)
    case "$*" in
      *candidate*down*) [ "${MOCK_CANDIDATE_DOWN_FAIL:-0}" = 1 ] && exit 76 ;;
      *"stop 9router bot-prod"*) [ "${MOCK_PROD_STOP_FAIL:-0}" = 1 ] && exit 77 ;;
    esac
    case "$*" in
      *"ps -q 9router"*) printf 'router-cid\n' ;;
      *"ps -q bot-prod"*) printf 'bot-cid\n' ;;
      *"--profile ops run"*backup*)
        mkdir -p "$MOCK_ROOT/backups"
        printf 'backup-data\n' > "$MOCK_ROOT/backups/bot-20260802T000000Z.sqlite"
        printf '/backups/bot-20260802T000000Z.sqlite\n' ;;
      *candidate*up*) : > "$MOCK_ROOT/candidate-created"; printf 'candidate-up\n' ;;
    esac
    printf 'compose %s\n' "$*" >> "$MOCK_ROOT/calls.log"
    case "$*" in
      *bot-prod*)
        printf 'bot-restart\n' >> "$MOCK_ROOT/calls.log"
        bot_image=$(sed -n 's/^BOT_IMAGE=//p' "$MOCK_ROOT/.env" | head -n 1)
        printf 'bot-image=%s\n' "$bot_image" >> "$MOCK_ROOT/calls.log"
        ;;
    esac
    case "$*" in
      *router-rollback*)
        rollback_file=$(printf '%s\n' "$*" | sed -n 's#.*-f \([^ ]*router-rollback[^ ]*\).*#\1#p' | head -n 1)
        if [ -f "$rollback_file" ]; then
          printf 'rollback-router-image=%s\n' "$(sed -n 's/^    image: //p' "$rollback_file" | head -n 1)" >> "$MOCK_ROOT/calls.log"
          printf 'rollback-router-volume=%s\n' "$(sed -n 's/^    name: //p' "$rollback_file" | head -n 1)" >> "$MOCK_ROOT/calls.log"
        fi
        ;;
    esac
    ;;
  *) ;;
esac
EOF
cat > "$root/bin/validator" <<'EOF'
#!/bin/sh
set -eu
printf 'validator url=%s volume=%s\n' "${CANDIDATE_URL:-}" "${CANDIDATE_VOLUME:-}" >> "$MOCK_ROOT/calls.log"
[ "${VALIDATE_FAIL:-0}" = 1 ] && exit 42
printf '00000000-0000-0000-0000-000000000001\n' > "$CANDIDATE_CLIENT_KEY_ID_FILE"
case "${CANDIDATE_URL:-}" in
  127.0.0.1:20128|*://127.0.0.1:20128) exit 41 ;;
esac
EOF
cat > "$root/bin/discord-validate" <<'EOF'
#!/bin/sh
set -eu
[ "${DISCORD_VALIDATE_CLIENT_ID:-}" = test-client ] || exit 81
[ "${DISCORD_VALIDATE_URL:-}" = https://discord.com/api/v10/users/@me ] || exit 85
[ -f "${DISCORD_VALIDATE_TOKEN_FILE:-}" ] || exit 82
[ "$(cat "$DISCORD_VALIDATE_TOKEN_FILE")" = "${MOCK_NEW_DISCORD:-}" ] || exit 83
[ "${MOCK_DISCORD_VALIDATE_FAIL:-0}" = 1 ] && exit 84
printf 'discord-validation-ok\n' >> "$MOCK_ROOT/calls.log"
EOF
cat > "$root/bin/canary" <<'EOF'
#!/bin/sh
set -eu
printf 'canary\n' >> "$MOCK_ROOT/calls.log"
[ "${CANARY_FAIL:-0}" = 1 ] && exit 43 || exit 0
EOF
cat > "$root/bin/cleanup" <<'EOF'
#!/bin/sh
set -eu
printf 'cleanup %s\n' "$*" >> "$MOCK_ROOT/cleanup.log"
case "$*" in *'*'*) exit 44;; esac
[ "${MOCK_CLEANUP_FAIL:-0}" = 1 ] && exit 75
[ "${CLEANUP_REFERENCED:-0}" = 1 ] && exit 45
exit 0
EOF
cat > "$root/bin/provision" <<'EOF'
#!/bin/sh
set -eu
printf 'provision\n' >> "$MOCK_ROOT/calls.log"
[ "${MOCK_PROVISION_FAIL:-0}" = 1 ] && exit 43
printf '%s\n' "${MOCK_PROVISION_KEY:-sk-provisioned-client-key-12345678}" > "$CANDIDATE_API_KEY_FILE"
EOF
cat > "$root/bin/production" <<'EOF'
#!/bin/sh
set -eu
[ "${PRODUCTION_URL:-}" = http://127.0.0.1:20128 ] || exit 61
[ "${MOCK_PRODUCTION_VALIDATE_FAIL:-0}" = 1 ] && exit 71
printf 'production url=%s volume=%s\n' "${PRODUCTION_URL:-}" "${PRODUCTION_VOLUME:-}" >> "$MOCK_ROOT/calls.log"
EOF
cat > "$root/bin/formal" <<'EOF'
#!/bin/sh
set -eu
[ "${CANDIDATE_URL:-}" = http://127.0.0.1:20128 ] || exit 62
printf 'formal-canary url=%s\n' "${CANDIDATE_URL:-}" >> "$MOCK_ROOT/calls.log"
EOF
cat > "$root/bin/sync" <<'EOF'
#!/bin/sh
set -eu
if [ "${MOCK_SYNC_CHANGED:-0}" = 1 ]; then printf '1\n' > "$MOCK_ROOT/restart-count"; else printf '0\n' > "$MOCK_ROOT/restart-count"; fi
EOF
cat > "$root/bin/sleep" <<'EOF'
#!/bin/sh
[ -n "${STATE_DIR:-}" ] && printf '%s\n' "$PPID" > "$STATE_DIR/watchdog-child.pid"
exit 0
EOF
cat > "$root/bin/mv" <<'EOF'
#!/bin/sh
case "$*" in
  *.env.router-cutover*) [ "${MOCK_ACTIVE_ENV_MV_FAIL:-0}" = 1 ] && exit 74 ;;
esac
exec /bin/mv "$@"
EOF
cat > "$root/bin/curl" <<'EOF'
#!/bin/sh
printf '{"id":"test-client"}\n200\n'
EOF
chmod 700 "$root/bin/"*

run_release() {
  PATH="$root/bin:$PATH" MOCK_ROOT="$root" MOCK_OLD_DISCORD="$old_discord" MOCK_OLD_CLIENT="$old_client" MOCK_OLD_DASHBOARD="$old_dashboard"   MOCK_NEW_DISCORD="$new_discord" MOCK_NEW_CLIENT="$new_client" MOCK_NEW_DASHBOARD="$new_dashboard"   MOCK_NEW_VOLUME="$new_volume" MOCK_OLD_ROUTER="$old_router" MOCK_OLD_VOLUME="$old_volume" MOCK_OLD_PROVIDER="$old_provider" MOCK_NEW_PROVIDER="$new_provider" MOCK_PROVISION_KEY="${MOCK_PROVISION_KEY:-sk-provisioned-client-key-12345678}" ROOT_DIR="$root" STATE_DIR="$root/state"   MANIFEST_PATH="$root/state/router-release.manifest" CRONTAB_BIN="${CRONTAB_BIN-$root/bin/crontab}" CRONTAB_FAIL="${CRONTAB_FAIL:-0}" CRONTAB_LIST_FAIL="${CRONTAB_LIST_FAIL:-0}" CRONTAB_SNAPSHOT_READ_FAIL="${CRONTAB_SNAPSHOT_READ_FAIL:-0}" CRONTAB_INSTALL_FAIL="${CRONTAB_INSTALL_FAIL:-0}" CRONTAB_RESTORE_FAIL="${CRONTAB_RESTORE_FAIL:-0}"   DOCKER_BIN="${DOCKER_BIN-$root/bin/docker}" GIT_BIN="${GIT_BIN-$root/bin/git}" CURL_BIN="${CURL_BIN-curl}" SHA256_BIN="${SHA256_BIN-sha256sum}" DATE_BIN="${DATE_BIN-date}" OPS_LOCK_FILE="/tmp/horo-test-ops.lock" MIYABI_OPS_LOCK_HELD="${MIYABI_OPS_LOCK_HELD-0}" ROUTER_RELEASE_IMAGE="${ROUTER_RELEASE_IMAGE:-$new_router}" ROUTER_RELEASE_REVISION="${ROUTER_RELEASE_REVISION:-6fcd27337a7893642c7fe630840d0a641743f28f}" NEW_BOT_IMAGE="${NEW_BOT_IMAGE-}"   ROUTER_VALIDATE_CMD="${ROUTER_VALIDATE_CMD-$root/bin/validator}" ROUTER_CANARY_CMD="${ROUTER_CANARY_CMD-$root/bin/canary}" ROUTER_PROVISION_CMD="${ROUTER_PROVISION_CMD-$root/bin/provision}" ROUTER_PRODUCTION_VALIDATE_CMD="${ROUTER_PRODUCTION_VALIDATE_CMD-$root/bin/production}" ROUTER_FORMAL_CANARY_CMD="${ROUTER_FORMAL_CANARY_CMD-$root/bin/formal}" ROUTER_PRODUCTION_CANARY_CMD="${ROUTER_PRODUCTION_CANARY_CMD-}" ROUTER_SYNC_KEY_CMD="${ROUTER_SYNC_KEY_CMD-$root/bin/sync}" ROUTER_VALIDATOR="${ROUTER_VALIDATOR-}" ROUTER_MARKER_CHECK_CMD="${ROUTER_MARKER_CHECK_CMD-}" MOCK_SYNC_CHANGED="${MOCK_SYNC_CHANGED:-1}" MOCK_HEALTH_FAIL="${MOCK_HEALTH_FAIL:-0}" VALIDATE_FAIL="${VALIDATE_FAIL:-0}" MOCK_PROVISION_FAIL="${MOCK_PROVISION_FAIL:-0}" MOCK_PRODUCTION_VALIDATE_FAIL="${MOCK_PRODUCTION_VALIDATE_FAIL:-0}" MOCK_CLEANUP_FAIL="${MOCK_CLEANUP_FAIL:-0}" MOCK_ACTIVE_ENV_MV_FAIL="${MOCK_ACTIVE_ENV_MV_FAIL:-0}" MOCK_DISCORD_VALIDATE_FAIL="${MOCK_DISCORD_VALIDATE_FAIL:-0}" MOCK_CANDIDATE_DOWN_FAIL="${MOCK_CANDIDATE_DOWN_FAIL:-0}" MOCK_PROD_STOP_FAIL="${MOCK_PROD_STOP_FAIL:-0}"   ROUTER_DISCORD_VALIDATE_CMD="${ROUTER_DISCORD_VALIDATE_CMD-$root/bin/discord-validate}" ROUTER_DISCORD_VALIDATE_URL="${ROUTER_DISCORD_VALIDATE_URL:-https://discord.com/api/v10/users/@me}" ROUTER_RELEASE_DISABLE_WATCHDOG="${ROUTER_RELEASE_DISABLE_WATCHDOG-1}" ROUTER_WATCHDOG_ONCE="${ROUTER_WATCHDOG_ONCE-0}" ROUTER_WATCHDOG_POLL_SECONDS="${ROUTER_WATCHDOG_POLL_SECONDS:-15}" ROUTER_RELEASE_TEST_MODE="${ROUTER_RELEASE_TEST_MODE-1}" ROUTER_RELEASE_SCRIPT="${ROUTER_RELEASE_SCRIPT-}" ROUTER_RELEASE_SKIP_GIT_CHECK="${ROUTER_RELEASE_SKIP_GIT_CHECK-}" ROUTER_RELEASE_SKIP_BUILD="${ROUTER_RELEASE_SKIP_BUILD-}"   ROUTER_CLEANUP_CMD="${ROUTER_CLEANUP_CMD-$root/bin/cleanup}" CLEANUP_REFERENCED="${CLEANUP_REFERENCED:-0}" ROUTER_SECRET_INPUT_FILE="${ROUTER_SECRET_INPUT_FILE:-$root/router-secrets}"   ROUTER_RELEASE_DRY_RUN="${ROUTER_RELEASE_DRY_RUN-0}" HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-1}" ROLLBACK_HEALTH_TIMEOUT="${ROLLBACK_HEALTH_TIMEOUT:-1}" ROLLBACK_HEALTH_ATTEMPTS="${ROLLBACK_HEALTH_ATTEMPTS:-1}"   ROUTER_NOW_EPOCH="${ROUTER_NOW_EPOCH:-}" ROUTER_TEST_NOW_EPOCH="${ROUTER_TEST_NOW_EPOCH:-}"   sh "$release" "$@"
}

manifest="$root/state/router-release.manifest"
field() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$manifest"
}
assert_manifest() {
  [ -f "$manifest" ] || { echo "manifest missing" >&2; exit 1; }
  [ "$(stat -c '%a' "$manifest")" = 600 ] || { echo "manifest mode is not 600" >&2; exit 1; }
  for key in state old_router_image new_router_image old_volume new_volume candidate_volume old_router_revision new_router_revision compose_sha old_bot_image new_bot_image db_backup db_backup_sha256 env_snapshot env_snapshot_sha256 maintenance_started_at maintenance_started_epoch candidate_port production_port candidate_env override selected_client_key_id cron_snapshot cron_snapshot_sha256 secrets_cleaned; do
    grep -q "^$key=" "$manifest" || { echo "manifest field missing: $key" >&2; exit 1; }
  done
  [ "$(field old_router_image)" = "$old_router" ]
  [ "$(field new_router_image)" = "$new_router" ]
  [ "$(field old_router_revision)" = "dddddddddddddddddddddddddddddddddddddddd" ]
  [ "$(field new_router_revision)" = "6fcd27337a7893642c7fe630840d0a641743f28f" ]
  printf "%s\n" "$(field selected_client_key_id)" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  [ "$(field old_volume)" = "$old_volume" ]
  [ "$(field new_volume)" = "$new_volume" ]
  [ "$(field candidate_volume)" = "$(field new_volume)" ]
  [ "$(field old_volume)" != "$(field new_volume)" ]
  case "$(field candidate_port)" in 20128) echo "candidate reused production port" >&2; exit 1;; esac
  override=$(field override)
  [ -f "$override" ]
  grep -Fq 127.0.0.1 "$override"
  [ "$(field production_port)" = "20128" ]
  snapshot=$(field env_snapshot)
  [ -f "$snapshot" ] || { echo "env snapshot missing" >&2; exit 1; }
  [ "$(stat -c '%a' "$snapshot")" = 600 ] || { echo "env snapshot mode is not 600" >&2; exit 1; }
  [ "$(sha256sum "$snapshot" | awk '{print $1}')" = "$(field env_snapshot_sha256)" ]
  backup=$(field db_backup)
  [ "$(sha256sum "$backup" | awk '{print $1}')" = "$(field db_backup_sha256)" ]
  [ "$(sha256sum "$root/docker-compose.yml" | awk '{print $1}')" = "$(field compose_sha)" ]
  ! grep -Fq "$old_discord" "$manifest"
  ! grep -Fq "$old_client" "$manifest"
  ! grep -Fq "$old_dashboard" "$manifest"
  ! grep -Fq "$new_discord" "$manifest"
  ! grep -Fq "$new_client" "$manifest"
  ! grep -Fq "$new_dashboard" "$manifest"
  ! grep -Fq "$old_provider" "$manifest"
  ! grep -Fq "$new_provider" "$manifest"
}
assert_minimal_env() {
  for required in DISCORD_TOKEN DISCORD_CLIENT_ID DISCORD_GUILD_ID NINE_ROUTER_JWT_SECRET NINE_ROUTER_API_KEY_SECRET NINE_ROUTER_MACHINE_ID_SALT AI_API_KEY BOT_IMAGE BOT_IMAGE_PREVIOUS; do
    grep -Eq "^${required}=.+$" "$root/.env" || { echo "required .env key missing: $required" >&2; exit 1; }
  done
  grep -Fxq 'AI_API_KEY=sk-provisioned-client-key-12345678' "$root/.env"
  ! grep -Eq '^GEMINI_API_KEY=' "$root/.env"
  ! grep -Fq "$old_provider" "$root/.env"
  ! grep -Fq "$new_provider" "$root/.env"
  while IFS= read -r line; do
    key=${line%%=*}
    case "$key" in
      DISCORD_TOKEN|DISCORD_CLIENT_ID|DISCORD_GUILD_ID|ADMIN_USER_IDS|AI_SETTINGS_USER_IDS|NINE_ROUTER_JWT_SECRET|NINE_ROUTER_API_KEY_SECRET|NINE_ROUTER_MACHINE_ID_SALT|AI_API_KEY|BOT_IMAGE|BOT_IMAGE_PREVIOUS) ;;
      *) echo "unexpected .env key: $key" >&2; exit 1 ;;
    esac
  done < "$root/.env"
  ! grep -Eq '^(ADMIN_USER_IDS|AI_SETTINGS_USER_IDS)=$' "$root/.env"
}
assert_rollback_env() {
  grep -q "^DISCORD_TOKEN=$new_discord$" "$root/.env" || { echo "rollback did not preserve validated Discord token" >&2; exit 1; }
  grep -q "^AI_API_KEY=$old_client$" "$root/.env" || { echo "rollback did not restore previous AI key" >&2; exit 1; }
  grep -q "^BOT_IMAGE=$old_bot$" "$root/.env" || { echo "rollback did not restore previous bot image" >&2; exit 1; }
}
run_case() {
  unset CRONTAB_FAIL CRONTAB_LIST_FAIL CRONTAB_SNAPSHOT_READ_FAIL CRONTAB_INSTALL_FAIL CRONTAB_RESTORE_FAIL MOCK_SYNC_CHANGED MOCK_HEALTH_FAIL VALIDATE_FAIL MOCK_PROVISION_FAIL MOCK_PRODUCTION_VALIDATE_FAIL MOCK_CLEANUP_FAIL MOCK_ACTIVE_ENV_MV_FAIL MOCK_DISCORD_VALIDATE_FAIL MOCK_CANDIDATE_DOWN_FAIL MOCK_PROD_STOP_FAIL MOCK_PROVISION_KEY CLEANUP_REFERENCED ROUTER_SECRET_INPUT_FILE ROUTER_DISCORD_VALIDATE_URL ROUTER_NOW_EPOCH ROUTER_TEST_NOW_EPOCH ROUTER_RELEASE_IMAGE ROUTER_RELEASE_REVISION ROUTER_RELEASE_TEST_MODE ROUTER_RELEASE_DRY_RUN ROUTER_RELEASE_DISABLE_WATCHDOG ROUTER_RELEASE_SCRIPT ROUTER_RELEASE_SKIP_GIT_CHECK ROUTER_RELEASE_SKIP_BUILD ROUTER_WATCHDOG_ONCE MIYABI_OPS_LOCK_HELD NEW_BOT_IMAGE ROUTER_VALIDATE_CMD ROUTER_VALIDATOR ROUTER_PROVISION_CMD ROUTER_CANARY_CMD ROUTER_SYNC_KEY_CMD ROUTER_PRODUCTION_VALIDATE_CMD ROUTER_FORMAL_CANARY_CMD ROUTER_PRODUCTION_CANARY_CMD ROUTER_CLEANUP_CMD ROUTER_MARKER_CHECK_CMD ROUTER_DISCORD_VALIDATE_CMD DOCKER_BIN GIT_BIN CRONTAB_BIN CURL_BIN SHA256_BIN DATE_BIN HEALTH_ATTEMPTS ROLLBACK_HEALTH_TIMEOUT ROLLBACK_HEALTH_ATTEMPTS
  rm -rf "$root/state" "$root/data/status"
  mkdir -p "$root/state" "$root/data/status"
  cp "$root/crontab.before" "$root/crontab"
  cp "$root/env.base" "$root/.env"
  chmod 600 "$root/.env"
  rm -f "$root/candidate-created"
  : > "$root/calls.log"
  : > "$root/docker.log"
  : > "$root/cleanup.log"
  rm -f "$root/crontab-list-count" /tmp/horo-test-ops.lock
  rm -f "$root/restart-count"
}
assert_no_candidate_artifacts() {
  [ ! -e "$root/candidate-created" ] || { echo "candidate volume marker retained" >&2; exit 1; }
  for pattern in \
    'router-discord-token.*' 'router-gemini-key.*' 'router-dashboard-password.*' \
    'router-initial-env.*' 'router-candidate-api-key.*' 'router-selected-client-id.*' \
    'router-candidate-env.*' 'router-candidate-compose.*'; do
    [ -z "$(find "$root/state" -type f -name "$pattern" -print -quit)" ] || {
      echo "candidate secret artifact retained: $pattern" >&2
      exit 1
    }
  done
}
write_backup_cron_line() {
  replacement=$1
  awk -v replacement="$replacement" '
    /#[[:space:]]*miyabi-bot-backup[[:space:]]*$/ && !done { print replacement; done=1; next }
    { print }
  ' "$root/crontab" > "$root/crontab.tmp"
  mv "$root/crontab.tmp" "$root/crontab"
}
assert_preflight_no_side_effects() {
  [ ! -s "$root/docker.log" ] || { echo "preflight rejection invoked Docker" >&2; exit 1; }
  [ -z "$(find "$root/state" -type f -print -quit)" ] || { echo "preflight rejection retained state artifact" >&2; exit 1; }
  assert_no_candidate_artifacts
}
assert_formal_preflight_no_side_effects() {
  assert_preflight_no_side_effects
  [ ! -e /tmp/horo-test-ops.lock ] || { echo "formal preflight rejection acquired operations lock" >&2; exit 1; }
}
assert_formal_override_rejected() {
  phase=$1
  override_name=$2
  override_value=$3
  expected_error=$4
  run_case
  export ROUTER_RELEASE_TEST_MODE=0 ROUTER_RELEASE_DRY_RUN=0 ROUTER_RELEASE_DISABLE_WATCHDOG=0 MIYABI_OPS_LOCK_HELD=0
  export ROUTER_RELEASE_SCRIPT= ROUTER_RELEASE_SKIP_GIT_CHECK=0 ROUTER_RELEASE_SKIP_BUILD=0 ROUTER_WATCHDOG_ONCE=0
  export ROUTER_DISCORD_VALIDATE_CMD= ROUTER_PROVISION_CMD= ROUTER_VALIDATE_CMD= ROUTER_VALIDATOR=
  export ROUTER_CANARY_CMD= ROUTER_SYNC_KEY_CMD= ROUTER_PRODUCTION_VALIDATE_CMD=
  export ROUTER_FORMAL_CANARY_CMD= ROUTER_PRODUCTION_CANARY_CMD= ROUTER_CLEANUP_CMD= ROUTER_MARKER_CHECK_CMD=
  export DOCKER_BIN=docker GIT_BIN=git CRONTAB_BIN=crontab CURL_BIN=curl SHA256_BIN=sha256sum DATE_BIN=date
  export "$override_name=$override_value"
  if formal_output=$(run_release prepare 2>&1); then
    echo "$override_name formal override unexpectedly accepted" >&2
    exit 1
  fi
  printf '%s\n' "$formal_output" | grep -Fq "$expected_error" || {
    printf '%s\n' "$formal_output" >&2
    echo "$override_name rejected for an unexpected reason" >&2
    exit 1
  }
  assert_formal_preflight_no_side_effects
}
for formal_hook in \
  ROUTER_DISCORD_VALIDATE_CMD ROUTER_PROVISION_CMD ROUTER_VALIDATE_CMD ROUTER_VALIDATOR \
  ROUTER_CANARY_CMD ROUTER_SYNC_KEY_CMD ROUTER_PRODUCTION_VALIDATE_CMD \
  ROUTER_FORMAL_CANARY_CMD ROUTER_PRODUCTION_CANARY_CMD ROUTER_CLEANUP_CMD ROUTER_MARKER_CHECK_CMD; do
  assert_formal_override_rejected "formal-reject-$formal_hook" "$formal_hook" /tmp/router-release-formal-hook "$formal_hook is test/dry-run only"
done
for formal_binary in DOCKER_BIN GIT_BIN CRONTAB_BIN CURL_BIN SHA256_BIN DATE_BIN; do
  assert_formal_override_rejected "formal-reject-$formal_binary" "$formal_binary" /tmp/router-release-formal-binary "$formal_binary override is test/dry-run only"
done
assert_formal_override_rejected formal-reject-ROUTER_RELEASE_SCRIPT ROUTER_RELEASE_SCRIPT /tmp/router-release-formal-script 'ROUTER_RELEASE_SCRIPT override is test/dry-run only'
assert_formal_override_rejected formal-reject-ROUTER_RELEASE_SKIP_GIT_CHECK ROUTER_RELEASE_SKIP_GIT_CHECK 1 'ROUTER_RELEASE_SKIP_GIT_CHECK is test/dry-run only'
assert_formal_override_rejected formal-reject-ROUTER_RELEASE_SKIP_BUILD ROUTER_RELEASE_SKIP_BUILD 1 'ROUTER_RELEASE_SKIP_BUILD is test/dry-run only'
assert_formal_override_rejected formal-reject-ROUTER_WATCHDOG_ONCE ROUTER_WATCHDOG_ONCE 1 'ROUTER_WATCHDOG_ONCE is test/dry-run only'
assert_formal_override_rejected formal-reject-MIYABI_OPS_LOCK_HELD MIYABI_OPS_LOCK_HELD 1 'MIYABI_OPS_LOCK_HELD is test/dry-run only'
phase=formal-reject-NEW_BOT_IMAGE
run_case
export ROUTER_RELEASE_TEST_MODE=0 ROUTER_RELEASE_DRY_RUN=0 ROUTER_RELEASE_DISABLE_WATCHDOG=0 MIYABI_OPS_LOCK_HELD=0
export ROUTER_RELEASE_SCRIPT= ROUTER_RELEASE_SKIP_GIT_CHECK=0 ROUTER_RELEASE_SKIP_BUILD=0 ROUTER_WATCHDOG_ONCE=0
export ROUTER_DISCORD_VALIDATE_CMD= ROUTER_PROVISION_CMD= ROUTER_VALIDATE_CMD= ROUTER_VALIDATOR=
export ROUTER_CANARY_CMD= ROUTER_SYNC_KEY_CMD= ROUTER_PRODUCTION_VALIDATE_CMD=
export ROUTER_FORMAL_CANARY_CMD= ROUTER_PRODUCTION_CANARY_CMD= ROUTER_CLEANUP_CMD= ROUTER_MARKER_CHECK_CMD=
export DOCKER_BIN=docker GIT_BIN=git CRONTAB_BIN=crontab CURL_BIN=curl SHA256_BIN=sha256sum DATE_BIN=date
export NEW_BOT_IMAGE='miyabi-bot:git-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
if formal_output=$(run_release prepare 2>&1); then
  echo "formal NEW_BOT_IMAGE mismatch unexpectedly accepted" >&2
  exit 1
fi
printf '%s\n' "$formal_output" | grep -Fq 'NEW_BOT_IMAGE must match the current main revision' || {
  printf '%s\n' "$formal_output" >&2
  echo "formal NEW_BOT_IMAGE mismatch rejected for an unexpected reason" >&2
  exit 1
}
! grep -Eq '(^|[[:space:]])(backup|build)([[:space:]]|$)' "$root/docker.log" || { echo "formal NEW_BOT_IMAGE mismatch reached backup/build" >&2; exit 1; }
! grep -Fq 'up image=' "$root/docker.log" || { echo "formal NEW_BOT_IMAGE mismatch switched Docker" >&2; exit 1; }
assert_no_candidate_artifacts
phase=dry-run-hook-fixture
run_case
ROUTER_RELEASE_TEST_MODE=0 ROUTER_RELEASE_DRY_RUN=1 run_release prepare >/dev/null 2>&1 || { echo "dry-run hook fixture failed" >&2; exit 1; }
[ -f "$manifest" ] || { echo "dry-run hook fixture did not create manifest" >&2; exit 1; }
phase=reject-world-readable-secret
run_case
bad_secret="$root/router-secrets.bad"
cp "$root/router-secrets" "$bad_secret"
chmod 644 "$bad_secret"
if ROUTER_SECRET_INPUT_FILE="$bad_secret" run_release prepare >/dev/null 2>&1; then
  echo "world-readable secret input accepted" >&2
  exit 1
fi
chmod 600 "$bad_secret"
phase=reject-symlink-manifest
run_case
rm -f "$manifest"
printf 'sentinel' > "$root/manifest-target"
ln -s "$root/manifest-target" "$manifest"
if run_release prepare >/dev/null 2>&1; then
  echo "symlink manifest accepted" >&2
  exit 1
fi
rm -f "$manifest"
phase=reject-cron-pause
run_case
if CRONTAB_FAIL=1 run_release prepare >/dev/null 2>&1; then
  echo "cron pause failure unexpectedly succeeded" >&2
  exit 1
fi
cmp -s "$root/crontab.before" "$root/crontab"
phase=reject-cron-install
run_case
if CRONTAB_INSTALL_FAIL=1 run_release prepare >/dev/null 2>&1; then
  echo "cron install failure unexpectedly succeeded" >&2
  exit 1
fi
cmp -s "$root/crontab.before" "$root/crontab"
assert_no_candidate_artifacts
phase=backup-cron-lock-valid
run_case
grep -Fq 'flock -n /tmp/horo-test-ops.lock /bin/backup # miyabi-bot-backup' "$root/crontab.before"
run_release prepare >/dev/null 2>&1 || { echo "locked backup cron rejected" >&2; exit 1; }
grep -Eq '(^|[[:space:]])backup([[:space:]]|$)' "$root/docker.log" || { echo "locked backup cron did not run backup" >&2; exit 1; }
phase=backup-cron-lock-double-dash-valid
run_case
write_backup_cron_line '* * * * * flock -n -- /tmp/horo-test-ops.lock /bin/backup # miyabi-bot-backup'
run_release prepare >/dev/null 2>&1 || { echo "double-dash locked backup cron rejected" >&2; exit 1; }
grep -Eq '(^|[[:space:]])backup([[:space:]]|$)' "$root/docker.log" || { echo "double-dash locked backup cron did not run backup" >&2; exit 1; }
phase=reject-cron-unlocked
run_case
write_backup_cron_line '* * * * * /bin/backup # miyabi-bot-backup'
cp "$root/crontab" "$root/crontab.expected"
if run_release prepare >/dev/null 2>&1; then
  echo "unlocked backup cron unexpectedly accepted" >&2
  exit 1
fi
cmp -s "$root/crontab.expected" "$root/crontab"
assert_preflight_no_side_effects
phase=reject-cron-duplicate
run_case
write_backup_cron_line '*/5 * * * * flock -n /tmp/horo-test-ops.lock /bin/backup # miyabi-bot-backup'
printf '%s\n' '* * * * * flock -n /tmp/horo-test-ops.lock /bin/backup # miyabi-bot-backup' >> "$root/crontab"
cp "$root/crontab" "$root/crontab.expected"
if run_release prepare >/dev/null 2>&1; then
  echo "duplicate backup cron unexpectedly accepted" >&2
  exit 1
fi
cmp -s "$root/crontab.expected" "$root/crontab"
assert_preflight_no_side_effects
phase=reject-cron-wrong-lock
run_case
write_backup_cron_line '* * * * * flock -n /tmp/wrong-horo-ops.lock /bin/backup # miyabi-bot-backup'
cp "$root/crontab" "$root/crontab.expected"
if run_release prepare >/dev/null 2>&1; then
  echo "wrong backup cron lock unexpectedly accepted" >&2
  exit 1
fi
cmp -s "$root/crontab.expected" "$root/crontab"
assert_preflight_no_side_effects
phase=reject-cron-argument-flock-disguise
run_case
write_backup_cron_line '* * * * * /bin/backup --note flock -n /tmp/horo-test-ops.lock # miyabi-bot-backup'
cp "$root/crontab" "$root/crontab.expected"
if run_release prepare >/dev/null 2>&1; then
  echo "argument flock disguise unexpectedly accepted" >&2
  exit 1
fi
cmp -s "$root/crontab.expected" "$root/crontab"
assert_preflight_no_side_effects
phase=reject-cron-comment-flock-disguise
run_case
write_backup_cron_line '* * * * * /bin/backup # flock -n /tmp/horo-test-ops.lock # miyabi-bot-backup'
cp "$root/crontab" "$root/crontab.expected"
if run_release prepare >/dev/null 2>&1; then
  echo "comment flock disguise unexpectedly accepted" >&2
  exit 1
fi
cmp -s "$root/crontab.expected" "$root/crontab"
assert_preflight_no_side_effects
phase=reject-cron-snapshot-read
run_case
cp "$root/crontab" "$root/crontab.expected"
if CRONTAB_SNAPSHOT_READ_FAIL=1 run_release prepare >/dev/null 2>&1; then
  echo "cron snapshot read failure unexpectedly succeeded" >&2
  exit 1
fi
cmp -s "$root/crontab.expected" "$root/crontab"
assert_preflight_no_side_effects
phase=reject-image-override-before-side-effects
run_case
if ROUTER_RELEASE_IMAGE='decolua/9router:0.5.45@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' run_release prepare >/dev/null 2>&1; then
  echo "non-pinned router image override unexpectedly accepted" >&2
  exit 1
fi
assert_preflight_no_side_effects
phase=reject-revision-override-before-side-effects
run_case
if ROUTER_RELEASE_REVISION='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' run_release prepare >/dev/null 2>&1; then
  echo "non-pinned router revision override unexpectedly accepted" >&2
  exit 1
fi
assert_preflight_no_side_effects
phase=reject-secret-duplicate
run_case
duplicate_secret="$root/router-secrets.duplicate"
cp "$root/router-secrets" "$duplicate_secret"
printf 'DISCORD_TOKEN=duplicate-token\n' >> "$duplicate_secret"
chmod 600 "$duplicate_secret"
if ROUTER_SECRET_INPUT_FILE="$duplicate_secret" run_release prepare >/dev/null 2>&1; then
  echo "duplicate secret input accepted" >&2
  exit 1
fi
phase=reject-secret-unknown
run_case
unknown_secret="$root/router-secrets.unknown"
cp "$root/router-secrets" "$unknown_secret"
printf 'UNKNOWN_SECRET=unexpected\n' >> "$unknown_secret"
chmod 600 "$unknown_secret"
if ROUTER_SECRET_INPUT_FILE="$unknown_secret" run_release prepare >/dev/null 2>&1; then
  echo "unknown secret input accepted" >&2
  exit 1
fi
phase=discord-token-validation
run_case
if MOCK_DISCORD_VALIDATE_FAIL=1 run_release prepare >/dev/null 2>&1; then
  echo "Discord token validation failure unexpectedly succeeded" >&2
  exit 1
fi
assert_no_candidate_artifacts
phase=discord-external-url
run_case
ROUTER_DISCORD_VALIDATE_URL=https://evil.invalid/users/@me
export ROUTER_DISCORD_VALIDATE_URL
discord_external_output=$(run_release prepare 2>&1) || { printf '%s\n' "$discord_external_output" >&2; echo "Discord validation did not remain on canonical URL" >&2; exit 1; }
unset ROUTER_DISCORD_VALIDATE_URL
phase=validator-abort-cleanup
run_case
if VALIDATE_FAIL=1 run_release prepare >/dev/null 2>&1; then
  echo "validator failure unexpectedly succeeded" >&2
  exit 1
fi
assert_no_candidate_artifacts
phase=provision-abort-cleanup
run_case
if MOCK_PROVISION_FAIL=1 run_release prepare >/dev/null 2>&1; then
  echo "provision failure unexpectedly succeeded" >&2
  exit 1
fi
assert_no_candidate_artifacts
phase=validated-cutover-finalize
run_case
prepare_output=$(run_release prepare 2>&1) || { printf '%s\n' "$prepare_output" >&2; exit 1; }
if printf '%s\n' "$prepare_output" | grep -Fq "$old_discord"; then
  echo "prepare leaked secret" >&2
  exit 1
fi
assert_manifest
grep -Fq 'provision' "$root/calls.log"
secret_artifacts=$(for key in discord_token_file gemini_key_file dashboard_password_file candidate_initial_env candidate_api_key_file selected_client_key_file; do field "$key"; done)
candidate_env_path=$(field candidate_env)
cron_snapshot_path=$(field cron_snapshot)
[ -f "$cron_snapshot_path" ] || { echo "cron snapshot missing" >&2; exit 1; }
[ "$(stat -c '%a' "$cron_snapshot_path")" = 600 ] || { echo "cron snapshot mode is not 600" >&2; exit 1; }
cmp -s "$cron_snapshot_path" "$root/crontab.before" || { echo "cron snapshot differs from live preflight" >&2; exit 1; }
grep -Fq 'keep-this' "$root/crontab"
! grep -Fq '/bin/backup # miyabi-bot-backup' "$root/crontab"
! grep -Fq '/bin/sync # miyabi-9router-key-sync' "$root/crontab"
sed -i 's/^state=validated$/state=prepared/' "$manifest"
if run_release cutover >/dev/null 2>&1; then
  echo "prepared state cutover unexpectedly succeeded" >&2
  exit 1
fi
sed -i 's/^state=prepared$/state=validated/' "$manifest"
grep -Fq 'keep-this' "$root/crontab"
! grep -Fq '/bin/backup # miyabi-bot-backup' "$root/crontab"
! grep -Fq '/bin/sync # miyabi-9router-key-sync' "$root/crontab"
! grep -Fq "$old_discord" "$root/calls.log"
! grep -Fq "$new_discord" "$root/calls.log"
[ -e "$root/candidate-created" ]
run_release status >/dev/null
cutover_output=$(run_release cutover 2>&1) || { printf '%s\n' "$cutover_output" >&2; echo "candidate cutover failed" >&2; exit 1; }
assert_minimal_env
grep -Fq validator "$root/calls.log"
grep -Fq canary "$root/calls.log"
grep -Fq 'formal-canary url=http://127.0.0.1:20128' "$root/calls.log"
bot_up_count=$(grep -Ec 'compose .*up -d( |.*)bot-prod' "$root/calls.log" || true)
[ "$bot_up_count" -eq 1 ] || { echo "expected exactly one bot up/recreate, got $bot_up_count" >&2; exit 1; }
force_bot_recreate_count=$(grep -Ec 'compose .*force-recreate.*bot-prod' "$root/calls.log" || true)
[ "$force_bot_recreate_count" -eq 0 ] || { echo "unexpected bot force-recreate count: $force_bot_recreate_count" >&2; exit 1; }
! grep -Fq "$new_client" "$root/docker.log"
[ "$(cat "$root/restart-count")" = 1 ]
[ ! -e "$candidate_env_path" ] || { echo "candidate env retained after cutover" >&2; exit 1; }
if run_release finalize >/dev/null 2>&1; then
  echo "finalize without confirmation unexpectedly succeeded" >&2
  exit 1
fi
if ROUTER_RELEASE_CONFIRM=YES run_release finalize >/dev/null 2>&1; then
  echo "finalize without old Gemini revocation unexpectedly succeeded" >&2
  exit 1
fi
ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1 || { echo "finalize failed" >&2; exit 1; }
! grep -Fq '*' "$root/cleanup.log"
cmp -s "$root/crontab.before" "$root/crontab"
for artifact in $secret_artifacts; do
  [ ! -e "$artifact" ] || { echo "secret artifact retained: $artifact" >&2; exit 1; }
done
[ -z "$(find "$root/state" -type f -print -quit)" ]


phase=finalize-resume-partial-artifacts
run_case
run_release prepare >/dev/null 2>&1 || { echo "partial-artifact prepare failed" >&2; exit 1; }
run_release cutover >/dev/null 2>&1 || { echo "partial-artifact cutover failed" >&2; exit 1; }
partial_candidate_override=$(field candidate_override)
partial_env_snapshot=$(field env_snapshot)
[ -f "$partial_candidate_override" ] || { echo "partial-artifact candidate override missing before crash simulation" >&2; exit 1; }
[ -f "$partial_env_snapshot" ] || { echo "partial-artifact env snapshot missing before crash simulation" >&2; exit 1; }
sed -i '/^finalize_phase=/d; s/^state=cutover$/state=finalizing/' "$manifest"
printf 'finalize_phase=old-volume-removed\n' >> "$manifest"
rm -f "$partial_candidate_override" "$partial_env_snapshot"
[ ! -e "$partial_candidate_override" ] || { echo "partial-artifact candidate override still present" >&2; exit 1; }
[ ! -e "$partial_env_snapshot" ] || { echo "partial-artifact env snapshot still present" >&2; exit 1; }
ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1 || { echo "partial-artifact finalize retry failed" >&2; exit 1; }
[ ! -e "$manifest" ] || { echo "partial-artifact manifest retained after retry" >&2; exit 1; }
! grep -Fq "volume-rm $old_volume" "$root/calls.log" || { echo "partial-artifact retry removed old volume twice" >&2; exit 1; }
[ -z "$(find "$root/state" -type f -print -quit)" ]


phase=finalize-early-missing-core
run_case
run_release prepare >/dev/null 2>&1 || { echo "early-finalize prepare failed" >&2; exit 1; }
run_release cutover >/dev/null 2>&1 || { echo "early-finalize cutover failed" >&2; exit 1; }
early_env_snapshot=$(field env_snapshot)
[ -f "$early_env_snapshot" ] || { echo "early-finalize env snapshot missing before crash simulation" >&2; exit 1; }
sed -i '/^finalize_phase=/d; s/^state=cutover$/state=finalizing/' "$manifest"
rm -f "$early_env_snapshot"
if ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1; then
  echo "early-finalize missing core artifact unexpectedly succeeded" >&2
  exit 1
fi
[ -f "$manifest" ] || { echo "early-finalize missing core artifact removed manifest" >&2; exit 1; }
grep -Fxq 'state=finalizing' "$manifest" || { echo "early-finalize state changed after core validation failure" >&2; exit 1; }
! grep -Fq "volume-rm $old_volume" "$root/calls.log" || { echo "early-finalize missing core artifact removed old volume" >&2; exit 1; }


phase=cron-restore-failure
run_case
run_release prepare >/dev/null 2>&1 || { echo "cron-restore prepare failed" >&2; exit 1; }
run_release cutover >/dev/null 2>&1 || { echo "cron-restore cutover failed" >&2; exit 1; }
if CRONTAB_RESTORE_FAIL=1 ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1; then
  echo "cron restore failure unexpectedly succeeded" >&2
  exit 1
fi
[ -f "$manifest" ] || { echo "manifest removed after cron restore failure" >&2; exit 1; }
! grep -Fq "volume-rm $old_volume" "$root/calls.log" || { echo "old volume removed after cron restore failure" >&2; exit 1; }
ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1 || { echo "cron restore retry failed" >&2; exit 1; }
[ -z "$(find "$root/state" -type f -print -quit)" ]


phase=cron-hash-tamper-finalize
run_case
run_release prepare >/dev/null 2>&1 || { echo "cron hash prepare failed" >&2; exit 1; }
run_release cutover >/dev/null 2>&1 || { echo "cron hash cutover failed" >&2; exit 1; }
cron_tamper=$(field cron_snapshot)
printf 'cron-tamper\n' >> "$cron_tamper"
if ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1; then
  echo "cron snapshot hash tamper unexpectedly finalized" >&2
  exit 1
fi
[ -f "$manifest" ] || { echo "manifest removed after cron hash tamper" >&2; exit 1; }
! grep -Fq "volume-rm $old_volume" "$root/calls.log" || { echo "old volume removed after cron hash tamper" >&2; exit 1; }


phase=cutover-crash-secret-cleanup
run_case
run_release prepare >/dev/null 2>&1 || { echo "crash-cleanup prepare failed" >&2; exit 1; }
run_release cutover >/dev/null 2>&1 || { echo "crash-cleanup cutover failed" >&2; exit 1; }
residual_artifacts=$(for key in discord_token_file gemini_key_file dashboard_password_file candidate_initial_env candidate_api_key_file selected_client_key_file candidate_env; do field "$key"; done)
for artifact in $residual_artifacts; do
  mkdir -p "$(dirname "$artifact")"
  printf 'residual-secret-marker\n' > "$artifact"
  chmod 600 "$artifact"
done
ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1 || { echo "crash residual cleanup failed" >&2; exit 1; }
for artifact in $residual_artifacts; do
  [ ! -e "$artifact" ] || { echo "residual secret retained: $artifact" >&2; exit 1; }
done
[ -z "$(find "$root/state" -type f -print -quit)" ]


phase=unchanged-key
run_case
MOCK_PROVISION_KEY="$old_client" MOCK_SYNC_CHANGED=0 run_release prepare >/dev/null 2>&1 || { echo "unchanged-key prepare failed" >&2; exit 1; }
assert_manifest
MOCK_PROVISION_KEY="$old_client" MOCK_SYNC_CHANGED=0 run_release cutover >/dev/null 2>&1 || { echo "unchanged-key cutover failed" >&2; exit 1; }
[ "$(cat "$root/restart-count")" = 0 ]
! grep -Eq 'compose .*force-recreate.*bot-prod' "$root/calls.log"
ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1 || { echo "unchanged-key finalize failed" >&2; exit 1; }
[ -z "$(find "$root/state" -type f -print -quit)" ]


manifest_tamper_case() {
  tamper_name=$1
  tamper_key=$2
  tamper_value=$3
  phase="manifest-tamper-$tamper_name"
  run_case
  tamper_prepare_output=$(run_release prepare 2>&1) || { printf '%s\n' "$tamper_prepare_output" >&2; echo "$tamper_name prepare failed" >&2; exit 1; }
  assert_manifest
  awk -F= -v key="$tamper_key" -v value="$tamper_value" '{ if ($1 == key) { print key "=" value; next } print }' "$manifest" > "$manifest.tmp"
  chmod 600 "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
  if run_release cutover >/dev/null 2>&1; then
    echo "$tamper_name unexpectedly accepted" >&2
    exit 1
  fi
}
manifest_tamper_case image new_router_image 'decolua/9router:0.5.45@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
manifest_tamper_case revision new_router_revision 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
manifest_tamper_case volume candidate_volume 'horo-discord-bot-tampered-volume'

phase=db-hash-tamper
run_case
run_release prepare >/dev/null 2>&1 || { echo "db hash prepare failed" >&2; exit 1; }
assert_manifest
printf 'tampered-backup\n' >> "$(field db_backup)"
if run_release cutover >/dev/null 2>&1; then
  echo "database backup hash tamper unexpectedly accepted" >&2
  exit 1
fi
! grep -Eq '^state=rolled_back$' "$manifest" || { echo "database restore failure incorrectly marked rolled_back" >&2; exit 1; }

phase=compose-hash-tamper
run_case
run_release prepare >/dev/null 2>&1 || { echo "compose hash prepare failed" >&2; exit 1; }
assert_manifest
printf '\n# compose tamper\n' >> "$root/docker-compose.yml"
if run_release cutover >/dev/null 2>&1; then
  echo "compose hash tamper unexpectedly accepted" >&2
  exit 1
fi

phase=broken-candidate-env
run_case
run_release prepare >/dev/null 2>&1 || { echo "candidate env symlink prepare failed" >&2; exit 1; }
assert_manifest
broken_candidate_env=$(field candidate_env)
rm -f "$broken_candidate_env"
printf 'outside-secret\n' > "$root/outside-candidate-env"
ln -s "$root/outside-candidate-env" "$broken_candidate_env"
if run_release cutover >/dev/null 2>&1; then
  echo "candidate env symlink unexpectedly accepted" >&2
  exit 1
fi

phase=status-manifest-mode
run_case
run_release prepare >/dev/null 2>&1 || { echo "status mode prepare failed" >&2; exit 1; }
chmod 644 "$manifest"
if run_release status >/dev/null 2>&1; then
  echo "world-readable manifest status unexpectedly succeeded" >&2
  exit 1
fi
phase=symlink-state-directory
run_case
rm -rf "$root/state"
mkdir -p "$root/status-target"
ln -s "$root/status-target" "$root/state"
if run_release prepare >/dev/null 2>&1; then
  echo "symlinked state directory prepare unexpectedly succeeded" >&2
  exit 1
fi
if run_release status >/dev/null 2>&1; then
  echo "symlinked state directory status unexpectedly succeeded" >&2
  exit 1
fi

phase=watchdog-validated-deadline
run_case
run_release prepare >/dev/null 2>&1 || { echo "watchdog validated prepare failed" >&2; exit 1; }
assert_manifest
watchdog_epoch=$(field maintenance_started_epoch)
ROUTER_WATCHDOG_ONCE=1 ROUTER_NOW_EPOCH=$((watchdog_epoch + 5100)) run_release watchdog >/dev/null 2>&1 || { echo "validated watchdog run failed" >&2; exit 1; }
grep -Eq '^state=rolled_back$' "$manifest" || { echo "validated watchdog did not rollback" >&2; exit 1; }
grep -Fq "rollback-router-image=$old_router" "$root/calls.log" || { echo "validated watchdog rollback image missing" >&2; exit 1; }

phase=watchdog-cutover-deadline
run_case
run_release prepare >/dev/null 2>&1 || { echo "watchdog cutover prepare failed" >&2; exit 1; }
assert_manifest
watchdog_epoch=$(field maintenance_started_epoch)
sed -i 's/^state=validated$/state=cutover/' "$manifest"
ROUTER_WATCHDOG_ONCE=1 ROUTER_NOW_EPOCH=$((watchdog_epoch + 5100)) run_release watchdog >/dev/null 2>&1 || { echo "cutover watchdog run failed" >&2; exit 1; }
grep -Eq '^state=rolled_back$' "$manifest" || { echo "cutover watchdog did not rollback" >&2; exit 1; }

phase=watchdog-finalize-guard
run_case
run_release prepare >/dev/null 2>&1 || { echo "watchdog finalize prepare failed" >&2; exit 1; }
assert_manifest
watchdog_epoch=$(field maintenance_started_epoch)
sed -i 's/^state=validated$/state=finalizing/' "$manifest"
printf 'phase=finalize\n' >> "$manifest"
chmod 600 "$manifest"
ROUTER_WATCHDOG_ONCE=1 ROUTER_NOW_EPOCH=$((watchdog_epoch + 5100)) run_release watchdog >/dev/null 2>&1 || { echo "finalize watchdog run failed" >&2; exit 1; }
grep -Eq '^state=finalizing$' "$manifest" || { echo "finalize watchdog incorrectly rolled back" >&2; exit 1; }
! grep -Fq "rollback-router-image=" "$root/calls.log"

phase=watchdog-rolled-back-guard
run_case
run_release prepare >/dev/null 2>&1 || { echo "watchdog rolled-back prepare failed" >&2; exit 1; }
assert_manifest
watchdog_epoch=$(field maintenance_started_epoch)
sed -i 's/^state=validated$/state=rolled_back/' "$manifest"
ROUTER_WATCHDOG_ONCE=1 ROUTER_NOW_EPOCH=$((watchdog_epoch + 5100)) run_release watchdog >/dev/null 2>&1 || { echo "rolled-back watchdog run failed" >&2; exit 1; }
grep -Eq '^state=rolled_back$' "$manifest"
! grep -Fq "rollback-router-image=" "$root/calls.log"

phase=watchdog-manifest-removed
run_case
run_release prepare >/dev/null 2>&1 || { echo "watchdog manifest removal prepare failed" >&2; exit 1; }
watchdog_epoch=$(field maintenance_started_epoch)
rm -f "$manifest"
ROUTER_WATCHDOG_ONCE=1 ROUTER_NOW_EPOCH=$((watchdog_epoch + 5100)) run_release watchdog >/dev/null 2>&1 || { echo "removed manifest watchdog run failed" >&2; exit 1; }
! grep -Fq "rollback-router-image=" "$root/calls.log"

phase=watchdog-child-isolation
run_case
ROUTER_RELEASE_DISABLE_WATCHDOG=0 ROUTER_WATCHDOG_ONCE=0 ROUTER_WATCHDOG_POLL_SECONDS=1 run_release prepare >/dev/null 2>&1 || { echo "watchdog-enabled prepare failed" >&2; exit 1; }
watchdog_pid=$(field watchdog_pid)
printf '%s\n' "$watchdog_pid" | grep -Eq '^[0-9]+$' || { echo "watchdog pid missing" >&2; exit 1; }
watchdog_env=/proc/$watchdog_pid/environ
watchdog_cmd=/proc/$watchdog_pid/cmdline
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "$watchdog_env" ] && break
done
[ -e "$watchdog_env" ] || { echo "watchdog child exited before isolation check" >&2; exit 1; }
tr '\000' '\n' < "$watchdog_env" | grep -Fq "$old_discord" && { echo "watchdog inherited Discord secret env" >&2; exit 1; }
tr '\000' '\n' < "$watchdog_env" | grep -Fq "$new_provider" && { echo "watchdog inherited provider secret env" >&2; exit 1; }
tr '\000' ' ' < "$watchdog_cmd" | grep -Fq "$old_discord" && { echo "watchdog argv leaked Discord secret" >&2; exit 1; }
[ ! -e "/proc/$watchdog_pid/fd/9" ] || { echo "watchdog inherited lock fd" >&2; exit 1; }
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true

phase=candidate-down-failure
run_case
run_release prepare >/dev/null 2>&1 || { echo "candidate down failure prepare failed" >&2; exit 1; }
if MOCK_CANDIDATE_DOWN_FAIL=1 run_release cutover >/dev/null 2>&1; then
  echo "candidate down failure unexpectedly switched" >&2
  exit 1
fi
assert_rollback_env
! grep -Fq "bot-image=$new_bot" "$root/calls.log" || { echo "candidate down failure started production bot" >&2; exit 1; }

phase=production-stop-failure
run_case
production_stop_prepare=$(run_release prepare 2>&1) || { printf '%s\n' "$production_stop_prepare" >&2; echo "production stop failure prepare failed" >&2; exit 1; }
if MOCK_PROD_STOP_FAIL=1 run_release cutover >/dev/null 2>&1; then
  echo "production stop failure unexpectedly switched" >&2
  exit 1
fi
assert_rollback_env
! grep -Fq "bot-image=$new_bot" "$root/calls.log" || { echo "production stop failure started production bot" >&2; exit 1; }

phase=production-validator-failure
run_case
run_release prepare >/dev/null 2>&1 || { echo "production validator prepare failed" >&2; exit 1; }
if MOCK_PRODUCTION_VALIDATE_FAIL=1 run_release cutover >/dev/null 2>&1; then
  echo "production validator failure unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq "rollback-router-image=$old_router" "$root/calls.log" || { echo "production validator failure did not rollback router" >&2; exit 1; }
grep -Fq "rollback-router-volume=$old_volume" "$root/calls.log" || { echo "production validator failure did not rollback volume" >&2; exit 1; }
grep -Eq '^state=rolled_back$' "$manifest" || { echo "production validator rollback state missing" >&2; exit 1; }

phase=active-env-rename-failure
run_case
run_release prepare >/dev/null 2>&1 || { echo "active env rename prepare failed" >&2; exit 1; }
if MOCK_ACTIVE_ENV_MV_FAIL=1 run_release cutover >/dev/null 2>&1; then
  echo "active env rename failure unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq "rollback-router-image=$old_router" "$root/calls.log" || { echo "active env rename failure did not rollback router" >&2; exit 1; }
assert_rollback_env

phase=env-snapshot-hash-rollback-failure
run_case
run_release prepare >/dev/null 2>&1 || { echo "env hash rollback prepare failed" >&2; exit 1; }
assert_manifest
printf 'tampered-env-snapshot\n' >> "$(field env_snapshot)"
if run_release rollback >/dev/null 2>&1; then
  echo "tampered env snapshot rollback unexpectedly succeeded" >&2
  exit 1
fi
[ -f "$manifest" ] || { echo "manifest removed after env restore failure" >&2; exit 1; }
! grep -Eq '^state=rolled_back$' "$manifest" || { echo "env restore failure incorrectly marked rolled_back" >&2; exit 1; }

phase=cleanup-runtime-failure
run_case
run_release prepare >/dev/null 2>&1 || { echo "cleanup runtime prepare failed" >&2; exit 1; }
run_release cutover >/dev/null 2>&1 || { echo "cleanup runtime cutover failed" >&2; exit 1; }
if MOCK_CLEANUP_FAIL=1 ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1; then
  echo "cleanup runtime failure unexpectedly succeeded" >&2
  exit 1
fi
[ -f "$manifest" ] || { echo "manifest removed after runtime cleanup failure" >&2; exit 1; }
! grep -Fq "volume-rm $old_volume" "$root/calls.log" || { echo "old volume removed after runtime cleanup failure" >&2; exit 1; }
ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1 || { echo "cleanup runtime retry failed" >&2; exit 1; }


phase=cleanup-reference
run_case
run_release prepare >/dev/null 2>&1 || { echo "cleanup-failure prepare failed" >&2; exit 1; }
assert_manifest
run_release cutover >/dev/null 2>&1 || { echo "cleanup-failure cutover failed" >&2; exit 1; }
if ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES CLEANUP_REFERENCED=1 run_release finalize >/dev/null 2>&1; then
  echo "referenced old volume cleanup unexpectedly succeeded" >&2
  exit 1
fi
[ -f "$manifest" ] || { echo "manifest removed after cleanup failure" >&2; exit 1; }
ROUTER_RELEASE_CONFIRM=YES ROUTER_OLD_GEMINI_REVOKED=YES run_release finalize >/dev/null 2>&1 || { echo "finalize retry failed" >&2; exit 1; }
[ -z "$(find "$root/state" -type f -print -quit)" ]


phase=deadline-rollback
run_case
prepare_output=$(run_release prepare 2>&1) || { printf '%s\n' "$prepare_output" >&2; exit 1; }
assert_manifest
maintenance_epoch=$(field maintenance_started_epoch)
[ -n "$maintenance_epoch" ]
if ROUTER_NOW_EPOCH=$((maintenance_epoch + 5101)) MOCK_HEALTH_FAIL=1 run_release cutover >/dev/null 2>&1; then
  echo "85 minute cutover unexpectedly succeeded" >&2
  exit 1
fi
grep -Eq 'rollback|volume-rm|compose' "$root/calls.log"

phase=rollback-timeout-clamp
run_case
run_release prepare >/dev/null 2>&1 || { echo "rollback timeout prepare failed" >&2; exit 1; }
assert_manifest
rollback_started=$(date +%s)
if ROLLBACK_HEALTH_TIMEOUT=999999 ROLLBACK_HEALTH_ATTEMPTS=1 MOCK_HEALTH_FAIL=1 run_release cutover >/dev/null 2>&1; then
  echo "rollback timeout failure unexpectedly succeeded" >&2
  exit 1
fi
rollback_elapsed=$(( $(date +%s) - rollback_started ))
[ "$rollback_elapsed" -lt 20 ] || { echo "rollback exceeded bounded test window: ${rollback_elapsed}s" >&2; exit 1; }

phase=post-start-rollback
run_case
run_release prepare >/dev/null 2>&1 || { echo "post-start rollback prepare failed" >&2; exit 1; }
assert_manifest
sed -i 's/^phase=.*/phase=healthy/' "$manifest"
sed -i 's/^volume_swapped=0$/volume_swapped=1/' "$manifest"
post_start_output=$(run_release rollback 2>&1) || { printf '%s\n' "$post_start_output" >&2; echo "post-start rollback failed" >&2; exit 1; }
grep -Fq "rollback-router-image=$old_router" "$root/calls.log" || { echo "post-start rollback did not restore router" >&2; exit 1; }
grep -Fq "rollback-router-volume=$old_volume" "$root/calls.log" || { echo "post-start rollback did not restore volume" >&2; exit 1; }
! grep -Fq "volume-rm $old_volume" "$root/calls.log" || { echo "post-start rollback deleted old volume" >&2; exit 1; }
candidate_rm_count=$(grep -Ec "volume-rm $new_volume$" "$root/calls.log" || true)
[ "$candidate_rm_count" -eq 1 ] || { echo "post-start rollback candidate volume rm count=$candidate_rm_count" >&2; exit 1; }

phase=manual-rollback
run_case
prepare_output=$(run_release prepare 2>&1) || { printf '%s\n' "$prepare_output" >&2; exit 1; }
assert_manifest
printf 'DISCORD_TOKEN=mutated\nAI_API_KEY=mutated\n' > "$root/.env"
chmod 600 "$root/.env"
run_release rollback >/dev/null 2>&1 || { echo "rollback failed (release command)" >&2; exit 1; }
assert_rollback_env
grep -Fq "rollback-router-image=$old_router" "$root/calls.log" || { echo "rollback failed (router image not restored)" >&2; exit 1; }
grep -Fq "rollback-router-volume=$old_volume" "$root/calls.log" || { echo "rollback failed (old volume not selected)" >&2; exit 1; }
! grep -Fq "volume-rm $old_volume" "$root/calls.log" || { echo "rollback deleted old volume" >&2; exit 1; }
candidate_rm_count=$(grep -Ec "volume-rm $new_volume$" "$root/calls.log" || true)
[ "$candidate_rm_count" -eq 1 ] || { echo "rollback candidate volume rm count=$candidate_rm_count" >&2; exit 1; }
grep -Fq "candidate-" "$root/calls.log" || { echo "rollback candidate runtime not stopped" >&2; exit 1; }
[ -f "$root/data/bot.sqlite" ] || { echo "rollback failed (DB restore absent)" >&2; exit 1; }
grep -Fxq 'backup-data' "$root/data/bot.sqlite" || { echo "rollback failed (DB backup content not restored)" >&2; exit 1; }

echo ok
