#!/bin/sh
set -eu
umask 077

root_dir=${ROOT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
docker_bin=${DOCKER_BIN:-docker}
git_bin=${GIT_BIN:-git}
crontab_bin=${CRONTAB_BIN:-crontab}
curl_bin=${CURL_BIN:-curl}
sha_bin=${SHA256_BIN:-sha256sum}
date_bin=${DATE_BIN:-date}
ops_lock_file=${OPS_LOCK_FILE:-/tmp/horo-discord-bot-ops.lock}
state_dir=${ROUTER_RELEASE_STATE_DIR:-${STATE_DIR:-$root_dir/data/status}}
manifest_path=${ROUTER_RELEASE_MANIFEST:-${MANIFEST_PATH:-$state_dir/router-release.manifest}}
release_script=${ROUTER_RELEASE_SCRIPT:-$0}
pinned_router_image='decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9'
pinned_router_revision='6fcd27337a7893642c7fe630840d0a641743f28f'
new_router_image=$pinned_router_image
new_router_revision=$pinned_router_revision
expected_router_image=$pinned_router_image
expected_router_revision=$pinned_router_revision
production_port=${ROUTER_PRODUCTION_PORT:-20128}
candidate_port=${ROUTER_CANDIDATE_PORT:-20129}
expected_production_port=20128
expected_candidate_port=20129
expected_new_volume=horo-discord-bot_9router-v0545
health_attempts=${HEALTH_ATTEMPTS:-90}
dry_run=${ROUTER_RELEASE_DRY_RUN:-0}
test_mode=${ROUTER_RELEASE_TEST_MODE:-0}
if [ "$dry_run" = 1 ]; then
  expected_production_port=${ROUTER_PRODUCTION_PORT:-20128}
  expected_candidate_port=${ROUTER_CANDIDATE_PORT:-20129}
  expected_new_volume=${NEW_ROUTER_VOLUME:-horo-discord-bot_9router-v0545}
fi
die() { printf '%s\n' "$*" >&2; exit 1; }
[ -z "${ROUTER_RELEASE_IMAGE+x}" ] || [ "$ROUTER_RELEASE_IMAGE" = "$pinned_router_image" ] || die 'router release image override is not the pinned official image'
[ -z "${ROUTER_RELEASE_REVISION+x}" ] || [ "$ROUTER_RELEASE_REVISION" = "$pinned_router_revision" ] || die 'router release revision override is not the pinned OCI revision'
if [ "$dry_run" != 1 ] && [ "$test_mode" != 1 ]; then
  [ "${ROUTER_RELEASE_DISABLE_WATCHDOG:-0}" != 1 ] || die 'watchdog disable is test-only'
  [ -z "${ROUTER_NOW_EPOCH:-}" ] && [ -z "${ROUTER_TEST_NOW_EPOCH:-}" ] || die 'fake clock is test-only'
fi
reject_formal_hook() {
  hook_name=$1
  hook_value=$(printenv "$hook_name" 2>/dev/null || true)
  [ -z "$hook_value" ] || die "$hook_name is test/dry-run only"
}
reject_formal_default_command() {
  command_name=$1; command_default=$2
  command_value=$(printenv "$command_name" 2>/dev/null || true)
  [ -z "$command_value" ] || [ "$command_value" = "$command_default" ] || die "$command_name override is test/dry-run only"
}
if [ "$dry_run" != 1 ] && [ "$test_mode" != 1 ]; then
  for hook_name in \
    ROUTER_DISCORD_VALIDATE_CMD ROUTER_PROVISION_CMD ROUTER_VALIDATE_CMD ROUTER_VALIDATOR \
    ROUTER_CANARY_CMD ROUTER_SYNC_KEY_CMD ROUTER_PRODUCTION_VALIDATE_CMD \
    ROUTER_FORMAL_CANARY_CMD ROUTER_PRODUCTION_CANARY_CMD ROUTER_CLEANUP_CMD ROUTER_MARKER_CHECK_CMD; do
    reject_formal_hook "$hook_name"
  done
  reject_formal_default_command DOCKER_BIN docker
  reject_formal_default_command GIT_BIN git
  reject_formal_default_command CRONTAB_BIN crontab
  reject_formal_default_command CURL_BIN curl
  reject_formal_default_command SHA256_BIN sha256sum
  reject_formal_default_command DATE_BIN date
  if [ -n "${ROUTER_RELEASE_SCRIPT:-}" ] && [ "$ROUTER_RELEASE_SCRIPT" != "$0" ]; then
    die 'ROUTER_RELEASE_SCRIPT override is test/dry-run only'
  fi
  [ "${ROUTER_RELEASE_SKIP_GIT_CHECK:-0}" != 1 ] || die 'ROUTER_RELEASE_SKIP_GIT_CHECK is test/dry-run only'
  [ "${ROUTER_RELEASE_SKIP_BUILD:-0}" != 1 ] || die 'ROUTER_RELEASE_SKIP_BUILD is test/dry-run only'
  [ "${ROUTER_WATCHDOG_ONCE:-0}" != 1 ] || die 'ROUTER_WATCHDOG_ONCE is test/dry-run only'
  [ "${MIYABI_OPS_LOCK_HELD:-0}" != 1 ] || die 'MIYABI_OPS_LOCK_HELD is test/dry-run only'
fi
[ ! -L "$state_dir" ] || die 'router release state directory must not be symlink'
if [ -e "$state_dir" ] && [ ! -d "$state_dir" ]; then die 'router release state path must be a directory'; fi
mkdir -p "$state_dir"
[ ! -L "$state_dir" ] || die 'router release state directory must not be symlink'
chmod 700 "$state_dir"
valid_decimal() { case "$1" in ''|*[!0-9]*) return 1;; esac; }
valid_port() { valid_decimal "$1" && [ "$1" -ge 1024 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null; }
valid_sha() { [ "${#1}" -eq 64 ] || return 1; case "$1" in *[!0-9a-f]*) return 1;; esac; }
valid_sha40() { [ "${#1}" -eq 40 ] || return 1; case "$1" in *[!0-9a-f]*) return 1;; esac; }
valid_image() {
  case "$1" in
    miyabi-bot:git-*) valid_sha40 "${1#miyabi-bot:git-}";;
    decolua/9router:*@sha256:*) valid_sha "${1##*@sha256:}";;
    *) return 1;;
  esac
}
valid_volume() { case "$1" in ''|*[!A-Za-z0-9_.-]*) return 1;; esac; }
valid_uuid() {
  case "$1" in
    ????????-????-????-????-????????????) case "$1" in *[!0-9a-fA-F-]*) return 1;; esac;;
    *) return 1;;
  esac
}
valid_scalar() { [ -n "$1" ] || return 1; case "$1" in *'
'*|*'='*) return 1;; esac; }

env_value_from() {
  file=$1; key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null || true
}
env_value() { env_value_from "$root_dir/.env" "$1"; }
file_hash() { "$sha_bin" "$1" 2>/dev/null | awk '{print $1}'; }
value_hash() { printf '%s' "$1" | "$sha_bin" 2>/dev/null | awk '{print $1}'; }

manifest_get() {
  key=$1; [ -f "$manifest_path" ] || return 1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$manifest_path"
}
manifest_set() {
  key=$1; value=$2; valid_scalar "$value" || die "invalid manifest value: $key"
  [ ! -L "$manifest_path" ] || die 'manifest path must not be symlink'
  if [ -f "$manifest_path" ]; then
    [ "$(stat -c '%a' "$manifest_path" 2>/dev/null || printf 0)" = 600 ] || die 'manifest must be mode 600'
  fi
  temporary=$(mktemp "$manifest_path.tmp.XXXXXX")
  if [ -f "$manifest_path" ]; then
    awk -F= -v key="$key" -v value="$value" '
      $1 == key { if (!found) { print key "=" value; found=1 }; next }
      { print }
      END { if (!found) print key "=" value }
    ' "$manifest_path" > "$temporary"
  else
    printf '%s=%s\n' "$key" "$value" > "$temporary"
  fi
  chmod 600 "$temporary"; mv "$temporary" "$manifest_path"
}
manifest_write() {
  state=$1; shift; temporary=$(mktemp "$manifest_path.tmp.XXXXXX")
  [ ! -L "$manifest_path" ] || { rm -f "$temporary"; die 'manifest path must not be symlink'; }
  if [ -f "$manifest_path" ]; then
    [ "$(stat -c '%a' "$manifest_path" 2>/dev/null || printf 0)" = 600 ] || { rm -f "$temporary"; die 'manifest must be mode 600'; }
  fi
  {
    printf 'state=%s\n' "$state"
    for entry in "$@"; do
      key=${entry%%=*}; value=${entry#*=}
      valid_scalar "$value" || { rm -f "$temporary"; die "invalid manifest value: $key"; }
      printf '%s=%s\n' "$key" "$value"
    done
  } > "$temporary"
  chmod 600 "$temporary"; mv "$temporary" "$manifest_path"
}
load_manifest() {
  state_path "$manifest_path" || die 'manifest path outside state directory'
  [ ! -L "$manifest_path" ] || die 'manifest must not be symlink'
  [ -f "$manifest_path" ] || die 'router release manifest not found'
  [ "$(stat -c '%a' "$manifest_path" 2>/dev/null || printf 0)" = 600 ] || die 'manifest must be mode 600'
  state=$(manifest_get state || true); [ -n "$state" ] || die 'manifest state missing'
  case "$state" in preparing|prepared|validated|cutover|finalizing|failed|rolled_back) ;; *) die 'manifest state invalid';; esac
  old_router_image=$(manifest_get old_router_image || true)
  new_router_image=$(manifest_get new_router_image || true)
  old_router_revision=$(manifest_get old_router_revision || true)
  new_router_revision=$(manifest_get new_router_revision || true)
  old_volume=$(manifest_get old_volume || true)
  new_volume=$(manifest_get new_volume || true)
  candidate_volume=$(manifest_get candidate_volume || true)
  old_bot_image=$(manifest_get old_bot_image || true)
  new_bot_image=$(manifest_get new_bot_image || true)
  db_backup=$(manifest_get db_backup || true)
  db_backup_sha256=$(manifest_get db_backup_sha256 || true)
  env_snapshot=$(manifest_get env_snapshot || true)
  env_snapshot_sha256=$(manifest_get env_snapshot_sha256 || true)
  candidate_env=$(manifest_get candidate_env || true)
  candidate_override=$(manifest_get candidate_override || true)
  active_override=$(manifest_get active_override || true)
  candidate_initial_env=$(manifest_get candidate_initial_env || true)
  candidate_initial_env_sha256=$(manifest_get candidate_initial_env_sha256 || true)
  cron_snapshot=$(manifest_get cron_snapshot || true)
  cron_snapshot_sha256=$(manifest_get cron_snapshot_sha256 || true)
  maintenance_started_at=$(manifest_get maintenance_started_at || true)
  maintenance_started_epoch=$(manifest_get maintenance_started_epoch || true)
  candidate_port=$(manifest_get candidate_port || true)
  production_port=$(manifest_get production_port || true)
  compose_sha=$(manifest_get compose_sha || true)
  selected_client_key_id=$(manifest_get selected_client_key_id || true)
  volume_swapped=$(manifest_get volume_swapped || true)
  old_ai_key_sha256=$(manifest_get old_ai_key_sha256 || true)
  new_ai_key_sha256=$(manifest_get new_ai_key_sha256 || true)
  discord_token_file=$(manifest_get discord_token_file || true)
  gemini_key_file=$(manifest_get gemini_key_file || true)
  dashboard_password_file=$(manifest_get dashboard_password_file || true)
  candidate_api_key_file=$(manifest_get candidate_api_key_file || true)
  selected_client_key_file=$(manifest_get selected_client_key_file || true)
  candidate_env_sha256=$(manifest_get candidate_env_sha256 || true)
  candidate_override_sha256=$(manifest_get candidate_override_sha256 || true)
  override=$(manifest_get override || true)
  discord_token_sha256=$(manifest_get discord_token_sha256 || true)
  gemini_key_sha256=$(manifest_get gemini_key_sha256 || true)
  dashboard_password_sha256=$(manifest_get dashboard_password_sha256 || true)
  candidate_api_key_sha256=$(manifest_get candidate_api_key_sha256 || true)
  secrets_cleaned=$(manifest_get secrets_cleaned || true)
  active_discord_token_sha256=$(manifest_get active_discord_token_sha256 || true)
  finalize_phase=$(manifest_get finalize_phase || true)
  watchdog_pid=$(manifest_get watchdog_pid || true)
  watchdog_started_epoch=$(manifest_get watchdog_started_epoch || true)
  for artifact_path in "$env_snapshot" "$candidate_env" "$candidate_override" "$active_override" "$candidate_initial_env" "$cron_snapshot" "$discord_token_file" "$gemini_key_file" "$dashboard_password_file" "$candidate_api_key_file" "$selected_client_key_file"; do
    [ -z "$artifact_path" ] || state_path "$artifact_path" || die 'manifest artifact path outside state directory'
  done
  valid_image "$old_router_image" || die 'manifest old router image invalid'
  valid_image "$new_router_image" || die 'manifest new router image invalid'
  valid_sha40 "$old_router_revision" || die 'manifest old router revision invalid'
  valid_sha40 "$new_router_revision" || die 'manifest new router revision invalid'
  [ "$new_router_image" = "$expected_router_image" ] || die 'manifest new router image mismatch'
  [ "$new_router_revision" = "$expected_router_revision" ] || die 'manifest new router revision mismatch'
  valid_volume "$old_volume" && valid_volume "$new_volume" && valid_volume "$candidate_volume" || die 'manifest volume invalid'
  [ "$new_volume" = "$expected_new_volume" ] || die 'manifest new volume mismatch'
  [ "$old_volume" != "$new_volume" ] || die 'manifest old/new volume collision'
  [ "$candidate_volume" = "$new_volume" ] || die 'manifest candidate volume mismatch'
  [ "$production_port" = "$expected_production_port" ] || die 'manifest production port mismatch'
  [ "$candidate_port" = "$expected_candidate_port" ] || die 'manifest candidate port mismatch'
  [ "$production_port" != "$candidate_port" ] || die 'manifest port collision'
  [ -z "$watchdog_pid" ] || { [ "$watchdog_pid" = none ] || valid_decimal "$watchdog_pid" || die 'manifest watchdog pid invalid'; }
  [ -z "$watchdog_started_epoch" ] || valid_decimal "$watchdog_started_epoch" || die 'manifest watchdog epoch invalid'
  [ -z "$active_discord_token_sha256" ] || [ "$active_discord_token_sha256" = none ] || valid_sha "$active_discord_token_sha256" || die 'manifest Discord token hash invalid'
  case "$finalize_phase" in ''|core-validated|cron-restored|runtime-cleaned|old-volume-removed|artifacts-cleaned) ;; *) die 'manifest finalize phase invalid';; esac
}
state_path() {
  case "$1" in "$state_dir"/*) ;; *) return 1;; esac
  case "$1" in *'/../'*|*/..|*'/./'*|*/.) return 1;; esac
}
state_path "$manifest_path" || die 'router release manifest path outside state directory'
valid_image "$expected_router_image" || die 'router release image ref invalid'
valid_sha40 "$expected_router_revision" || die 'router release revision invalid'
assert_private_artifact() {
  path=$1; hash=$2
  state_path "$path" || die "artifact path outside state: $path"
  [ -f "$path" ] || die "artifact missing: $path"
  [ ! -L "$path" ] || die "artifact must not be symlink: $path"
  [ "$(stat -c '%a' "$path" 2>/dev/null || printf 0)" = 600 ] || die "artifact mode must be 600: $path"
  [ -z "$hash" ] || [ "$(file_hash "$path")" = "$hash" ] || die "artifact hash mismatch: $path"
}
validate_manifest_artifacts() {
  assert_private_artifact "$env_snapshot" "$env_snapshot_sha256"
  assert_private_artifact "$candidate_override" "$candidate_override_sha256"
  assert_private_artifact "$cron_snapshot" "$cron_snapshot_sha256"
  [ ! -L "$root_dir/.env" ] || die 'environment file must not be symlink'
  [ "$(stat -c '%a' "$root_dir/.env" 2>/dev/null || printf 0)" = 600 ] || die 'environment file must be mode 600'
  if [ "$secrets_cleaned" != 1 ]; then
    assert_private_artifact "$candidate_env" "$candidate_env_sha256"
    assert_private_artifact "$candidate_initial_env" "$candidate_initial_env_sha256"
    assert_private_artifact "$discord_token_file" "$discord_token_sha256"
    assert_private_artifact "$gemini_key_file" "$gemini_key_sha256"
    assert_private_artifact "$dashboard_password_file" "$dashboard_password_sha256"
    assert_private_artifact "$candidate_api_key_file" "$candidate_api_key_sha256"
    assert_private_artifact "$selected_client_key_file" ""
  fi
  case "$db_backup" in "$root_dir/backups/"*) ;; *) die 'database backup path invalid';; esac
  case "$db_backup" in *'/../'*|*/..|*'/./'*|*/.) die 'database backup path traversal';; esac
  [ ! -L "$root_dir/backups" ] || die 'backups directory must not be symlink'
  [ -f "$db_backup" ] || die 'database backup missing'
  valid_sha "$db_backup_sha256" || die 'database backup hash missing'
  [ "$(file_hash "$db_backup")" = "$db_backup_sha256" ] || die 'database backup hash mismatch'
  valid_sha "$compose_sha" || die 'compose hash missing'
  [ "$(file_hash "$root_dir/docker-compose.yml")" = "$compose_sha" ] || die 'compose hash mismatch'
}

acquire_lock() {
  [ "${MIYABI_OPS_LOCK_HELD:-0}" = 1 ] && return 0
  lock_dir=$(dirname "$ops_lock_file"); mkdir -p "$lock_dir"
  exec 9>"$ops_lock_file"; flock 9
}
assert_backup_cron_lock() {
  backup_cron=$( "$crontab_bin" -l 2>/dev/null ) || return 1
  backup_line=$(printf '%s\n' "$backup_cron" | awk '
    /^[[:space:]]*#/ { next }
    {
      marker = match($0, /[[:space:]]#[[:space:]]*miyabi-bot-backup[[:space:]]*$/)
      if (!marker) next
      line_without_marker = substr($0, 1, RSTART - 1)
      # Keep the tag a real trailing cron comment, not an argument fragment.
      if (line_without_marker ~ /#/) next
      count++; line=line_without_marker
    }
    END { if (count != 1) exit 1; print line }
  ') || return 1
  printf '%s\n' "$backup_line" | awk -v lock="$ops_lock_file" '
    {
      # Accept only the fixed five-field crontab schedule followed directly by
      # flock -n [--] <exact lock> <backup command>.  Do not search arbitrary
      # arguments for a convincing-looking flock fragment.
      if (NF < 9 || $6 != "flock" || $7 != "-n") exit 1
      i = 8
      if ($i == "--") i++
      single = sprintf("%c", 39)
      path = $(i++)
      if (!(path == lock || path == "\"" lock "\"" || path == single lock single)) exit 1
      if (i > NF || $i ~ /^#/) exit 1
      ok = 1
    }
    END { exit !ok }
  ' || return 1
}
compose_prod() { "$docker_bin" compose --project-name horo-discord-bot "$@"; }
compose_file() {
  project=$1; env_file=$2; override=$3; shift 3
  "$docker_bin" compose --project-name "$project" --env-file "$env_file" \
    -f "$root_dir/docker-compose.yml" -f "$override" "$@"
}
compose_candidate() { compose_file "$candidate_project" "$candidate_env" "$candidate_override" "$@"; }
compose_active() {
  if [ -n "${active_override:-}" ] && [ -f "$active_override" ]; then
    "$docker_bin" compose --project-name horo-discord-bot \
      -f "$root_dir/docker-compose.yml" -f "$active_override" "$@"
  else
    compose_prod "$@"
  fi
}
wait_healthy() {
  service=$1; [ "$dry_run" = 1 ] && return 0
  count=0
  while [ "$count" -lt "$health_attempts" ]; do
    health_deadline_ok || return 1
    id=$(compose_prod ps -q "$service" 2>/dev/null || true)
    if [ -n "$id" ]; then
      status=$("$docker_bin" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      [ "$status" = healthy ] && return 0
    fi
    count=$((count + 1)); sleep 2
  done
  return 1
}
wait_healthy_active() {
  service=$1; [ "$dry_run" = 1 ] && return 0
  count=0
  while [ "$count" -lt "$health_attempts" ]; do
    health_deadline_ok || return 1
    id=$(compose_active ps -q "$service" 2>/dev/null || true)
    if [ -n "$id" ]; then
      status=$("$docker_bin" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      [ "$status" = healthy ] && return 0
    fi
    count=$((count + 1)); sleep 2
  done
  return 1
}
wait_healthy_candidate() {
  service=9router; [ "$dry_run" = 1 ] && return 0
  count=0
  while [ "$count" -lt "$health_attempts" ]; do
    health_deadline_ok || return 1
    id=$(compose_candidate ps -q "$service" 2>/dev/null || true)
    if [ -n "$id" ]; then
      status=$("$docker_bin" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      [ "$status" = healthy ] && return 0
    fi
    count=$((count + 1)); sleep 2
  done
  return 1
}
health_deadline_ok() {
  if [ "${rollback_in_progress:-0}" = 1 ]; then
    now_epoch=$(read_now_epoch); valid_decimal "$now_epoch" || return 1
    [ "$now_epoch" -lt "$rollback_deadline_epoch" ]
    return
  fi
  [ -z "${maintenance_started_epoch:-}" ] || check_deadline
}

read_tty_secret() {
  label=$1; tty_path=${ROUTER_RELEASE_TTY:-/dev/tty}
  [ -r "$tty_path" ] || die 'interactive terminal required'
  printf '%s：' "$label" >&2
  old_stty=$(stty -g < "$tty_path" 2>/dev/null || true)
  [ -z "$old_stty" ] || stty -echo < "$tty_path" 2>/dev/null || true
  IFS= read -r secret < "$tty_path" || true
  [ -z "$old_stty" ] || stty "$old_stty" < "$tty_path" 2>/dev/null || true
  printf '\n' >&2; valid_scalar "$secret" || die "$label invalid"
  printf '%s' "$secret"
}
secret_line() {
  index=$1; input=${ROUTER_SECRET_INPUT_FILE:-}
  if [ -n "$input" ]; then
    [ -f "$input" ] || die 'secret input file not found'
    [ ! -L "$input" ] || die 'secret input file symlink'
    mode=$(stat -c '%a' "$input" 2>/dev/null || printf 0)
    [ "$mode" = 600 ] || die 'secret input file must be mode 600'
    awk -F= '
      BEGIN { ok=1 }
      /^[[:space:]]*$/ { next }
      NF < 2 { ok=0; exit }
      $1 !~ /^(DISCORD_TOKEN|GEMINI_API_KEY|DASHBOARD_PASSWORD)$/ { ok=0; exit }
      ++seen[$1] > 1 { ok=0; exit }
      $0 ~ /\r$/ { ok=0; exit }
      END { exit(ok ? 0 : 1) }
    ' "$input" || die 'secret input keys invalid'
    case "$index" in
      1) key=DISCORD_TOKEN;;
      2) key=GEMINI_API_KEY;;
      3) key=DASHBOARD_PASSWORD;;
      *) die 'secret input index invalid';;
    esac
    secret=$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found=1 } END { exit(found ? 0 : 1) }' "$input" 2>/dev/null) || die 'secret input key missing'
    valid_scalar "$secret" || die 'secret input invalid'
    printf '%s' "$secret"; return
  fi
  case "$index" in
    1) read_tty_secret '新 Discord token';;
    2) read_tty_secret '新 Gemini API key';;
    3) read_tty_secret '新 Dashboard password';;
    *) die 'secret input index invalid';;
  esac
}
validate_discord_token() {
  [ "$dry_run" = 1 ] && return 0
  discord_validate_client_id=$(env_value_from "$env_snapshot" DISCORD_CLIENT_ID)
  [ -n "$discord_validate_client_id" ] || { printf '%s\n' 'Discord client id missing' >&2; return 1; }
  case "$new_discord_token" in *[!A-Za-z0-9._-]*) printf '%s\n' 'Discord token contains unsupported characters' >&2; return 1;; esac
  discord_validate_url=https://discord.com/api/v10/users/@me
  if [ -n "${ROUTER_DISCORD_VALIDATE_CMD:-}" ]; then
    export DISCORD_VALIDATE_URL="$discord_validate_url" DISCORD_VALIDATE_CLIENT_ID="$discord_validate_client_id" DISCORD_VALIDATE_TOKEN_FILE="$discord_token_file"
    sh -c "$ROUTER_DISCORD_VALIDATE_CMD" || return 1
    return 0
  fi
  discord_validate_response=$(printf 'header = "Authorization: Bot %s"\n' "$new_discord_token" | "$curl_bin" --silent --config - --output - --write-out '\n%{http_code}' --max-time 15 "$discord_validate_url" 2>/dev/null || true)
  discord_validate_status=$(printf '%s\n' "$discord_validate_response" | tail -n 1)
  [ "$discord_validate_status" = 200 ] || { printf '%s\n' 'Discord token validation failed' >&2; return 1; }
  discord_validate_body=$(printf '%s\n' "$discord_validate_response" | sed '$d')
  discord_validate_id=$(printf '%s\n' "$discord_validate_body" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ "$discord_validate_id" = "$discord_validate_client_id" ] || { printf '%s\n' 'Discord token identity mismatch' >&2; return 1; }
}
random_hex() {
  bytes=${1:-32}
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$bytes" 2>/dev/null
  else od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'; fi
}
random_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'
  else printf '%s-%s-%s-%s-%s\n' "$(random_hex 4)" "$(random_hex 2)" "4$(random_hex 1 | cut -c2-)" "8$(random_hex 1 | cut -c2-)" "$(random_hex 6)"; fi
}
assert_main_synced() {
  [ "${ROUTER_RELEASE_SKIP_GIT_CHECK:-0}" = 1 ] && return
  [ "$dry_run" = 1 ] && return 0
  branch=$("$git_bin" branch --show-current); [ "$branch" = main ] || die 'router release requires main'
  [ -z "$("$git_bin" status --porcelain)" ] || die 'router release worktree is dirty'
  "$git_bin" fetch --quiet origin main
  head_check=$("$git_bin" rev-parse HEAD); remote_check=$("$git_bin" rev-parse origin/main)
  [ "$head_check" = "$remote_check" ] || die 'main is not at origin/main'
}
inspect_router() {
  router_container=$(compose_prod ps -q 9router 2>/dev/null || true)
  if [ "$dry_run" != 1 ]; then
    [ -n "$router_container" ] || die 'running router container required for release'
    old_router_image=$("$docker_bin" inspect --format '{{.Config.Image}}' "$router_container" 2>/dev/null || true)
    old_router_revision=$("$docker_bin" inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$router_container" 2>/dev/null || true)
    old_volume=$("$docker_bin" inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$router_container" 2>/dev/null || true)
  else
    old_router_image=${OLD_ROUTER_IMAGE:-}; old_router_revision=${OLD_ROUTER_REVISION:-}; old_volume=${OLD_ROUTER_VOLUME:-}
    if [ -n "$router_container" ]; then
      [ -n "$old_router_image" ] || old_router_image=$("$docker_bin" inspect --format '{{.Config.Image}}' "$router_container" 2>/dev/null || true)
      [ -n "$old_router_revision" ] || old_router_revision=$("$docker_bin" inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$router_container" 2>/dev/null || true)
      [ -n "$old_volume" ] || old_volume=$("$docker_bin" inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$router_container" 2>/dev/null || true)
    fi
    [ -n "$old_router_image" ] || old_router_image=$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$root_dir/docker-compose.yml" | sed -n '/decolua\\/9router:/p' | head -n 1)
    [ -n "$old_volume" ] || old_volume=${PRODUCTION_ROUTER_OLD_VOLUME:-horo-discord-bot_9router-data}
  fi
  [ -n "$old_router_image" ] || die 'unable to inspect old router image'
  [ -n "$old_router_revision" ] || die 'unable to inspect old router revision'
  valid_volume "$old_volume" || die 'old volume invalid'
  if [ "$dry_run" != 1 ]; then
    valid_image "$old_router_image" || die 'old router image ref invalid'
    case "$old_router_image" in
      decolua/9router:*@sha256:*) valid_sha "${old_router_image##*@sha256:}" || die 'old router image digest invalid';;
      *) die 'old router image must be digest pinned';;
    esac
    valid_sha40 "$old_router_revision" || die 'old router revision invalid'
  fi
}
backup_database() {
  if [ "$dry_run" = 1 ]; then
    db_backup=${ROUTER_RELEASE_BACKUP_PATH:-$root_dir/backups/router-release-dry-run.sqlite}
    mkdir -p "$root_dir/backups"; [ ! -L "$db_backup" ] || die 'database backup target must not be symlink'; : > "$db_backup"; chmod 600 "$db_backup"
    db_backup_sha256=$(file_hash "$db_backup"); valid_sha "$db_backup_sha256" || die 'database backup hash invalid'; return
  fi
  mkdir -p "$root_dir/backups"
  output=$(BOT_IMAGE="$old_bot_image" compose_prod --profile ops run --rm --no-deps -T backup 2>/dev/null) || die 'database backup failed'
  name=$(printf '%s\n' "$output" | tail -n 1 | sed 's#^/backups/##')
  case "$name" in bot-[0-9]*T[0-9]*Z.sqlite) ;; *) die 'backup output invalid';; esac
  db_backup=$root_dir/backups/$name; [ -f "$db_backup" ] || die 'backup file missing'; [ ! -L "$db_backup" ] || die 'backup file must not be symlink'; chmod 600 "$db_backup"
  db_backup_sha256=$(file_hash "$db_backup"); valid_sha "$db_backup_sha256" || die 'database backup hash invalid'
}
write_secret_file() {
  target=$1; value=$2; valid_scalar "$value" || die 'secret invalid'
  [ ! -L "$target" ] || die 'secret target must not be symlink'
  target_dir=$(dirname "$target"); temporary=$(mktemp "$target_dir/.router-secret.XXXXXX") || die 'secret temporary file failed'
  printf '%s\n' "$value" > "$temporary" || { rm -f "$temporary"; die 'secret write failed'; }
  chmod 600 "$temporary" || { rm -f "$temporary"; die 'secret mode failed'; }
  mv "$temporary" "$target" || { rm -f "$temporary"; die 'secret install failed'; }
}
write_initial_env_file() {
  target=$1; value=$2; valid_scalar "$value" || die 'initial password invalid'
  [ ! -L "$target" ] || die 'initial environment target must not be symlink'
  target_dir=$(dirname "$target"); temporary=$(mktemp "$target_dir/.router-initial.XXXXXX") || die 'initial environment temporary file failed'
  printf 'INITIAL_PASSWORD=%s\n' "$value" > "$temporary" || { rm -f "$temporary"; die 'initial environment write failed'; }
  chmod 600 "$temporary" || { rm -f "$temporary"; die 'initial environment mode failed'; }
  mv "$temporary" "$target" || { rm -f "$temporary"; die 'initial environment install failed'; }
}
write_override() {
  target=$1; image=$2; volume=$3; port=$4; initial_env=${5:-}
  valid_image "$image" && valid_volume "$volume" && valid_port "$port" || die 'override value invalid'
  [ ! -L "$target" ] || die 'override target must not be symlink'
  target_dir=$(dirname "$target"); temporary=$(mktemp "$target_dir/.router-override.XXXXXX") || die 'override temporary file failed'
  cat > "$temporary" <<EOF
volumes:
  router-data:
    name: $volume
services:
  9router:
    image: $image
EOF
  if [ -n "$initial_env" ]; then
    cat >> "$temporary" <<EOF
    env_file:
      - "$initial_env"
EOF
  fi
  cat >> "$temporary" <<EOF
    ports:
      - "127.0.0.1:$port:20128"
    volumes:
      - router-data:/app/data
EOF
  chmod 600 "$temporary" || { rm -f "$temporary"; die 'override mode failed'; }
  mv "$temporary" "$target" || { rm -f "$temporary"; die 'override install failed'; }
}
write_candidate_env() {
  candidate_env=$state_dir/router-candidate-env.$maintenance_started_epoch
  [ ! -L "$candidate_env" ] || die 'candidate environment target must not be symlink'
  target_dir=$(dirname "$candidate_env"); temporary=$(mktemp "$target_dir/.router-candidate-env.XXXXXX") || die 'candidate environment temporary file failed'
  {
    printf 'DISCORD_TOKEN=%s\n' "$new_discord_token"
    printf 'DISCORD_CLIENT_ID=%s\n' "$(env_value_from "$env_snapshot" DISCORD_CLIENT_ID)"
    printf 'DISCORD_GUILD_ID=%s\n' "$(env_value_from "$env_snapshot" DISCORD_GUILD_ID)"
    printf 'ADMIN_USER_IDS=%s\n' "$(env_value_from "$env_snapshot" ADMIN_USER_IDS)"
    printf 'AI_SETTINGS_USER_IDS=%s\n' "$(env_value_from "$env_snapshot" AI_SETTINGS_USER_IDS)"
    printf 'BOT_IMAGE=%s\n' "$new_bot_image"
    printf 'AI_API_KEY=%s\n' "$generated_client_key"
    printf 'NINE_ROUTER_JWT_SECRET=%s\n' "$new_jwt_secret"
    printf 'NINE_ROUTER_API_KEY_SECRET=%s\n' "$new_api_secret"
    printf 'NINE_ROUTER_MACHINE_ID_SALT=%s\n' "$new_machine_salt"
    printf 'NINE_ROUTER_BIND_ADDRESS=127.0.0.1\n'
    printf 'NINE_ROUTER_HOST_PORT=%s\n' "$candidate_port"
    printf 'NINE_ROUTER_VOLUME=%s\n' "$candidate_volume"
  } > "$temporary" || { rm -f "$temporary"; die 'candidate environment write failed'; }
  chmod 600 "$temporary" || { rm -f "$temporary"; die 'candidate environment mode failed'; }
  mv "$temporary" "$candidate_env" || { rm -f "$temporary"; die 'candidate environment install failed'; }
}
volume_exists() { [ "$dry_run" = 1 ] && return 1; "$docker_bin" volume inspect "$1" >/dev/null 2>&1; }
remove_volume_exact() {
  volume=$1; valid_volume "$volume" || { printf '%s\n' 'invalid volume name' >&2; return 1; }
  [ "$dry_run" = 1 ] && return 0
  refs=$("$docker_bin" ps -a --filter "volume=$volume" -q 2>/dev/null || true)
  [ -z "$refs" ] || { printf 'volume still referenced: %s\n' "$volume" >&2; return 1; }
  "$docker_bin" volume rm "$volume" >/dev/null || return 1
}
cleanup_candidate_runtime() {
  [ -n "${candidate_project:-}" ] || return 0
  [ "$dry_run" = 1 ] && return 0
  compose_candidate down --remove-orphans >/dev/null 2>&1 || return 1
  [ -n "${candidate_volume:-}" ] || return 0
  candidate_refs=$("$docker_bin" ps -a --filter "volume=$candidate_volume" -q 2>/dev/null || true)
  [ -z "$candidate_refs" ] || return 1
}
cleanup_secret_files() {
  if [ -z "${secret_files:-}" ]; then
    secret_files="${discord_token_file:-} ${gemini_key_file:-} ${dashboard_password_file:-} ${candidate_initial_env:-} ${candidate_api_key_file:-} ${selected_client_key_file:-} ${candidate_env:-} ${rollback_discord_token_file:-}"
  fi
  cleanup_secret_error=0
  for path in ${secret_files:-}; do
    case "$path" in "$state_dir"/*) rm -f "$path" || cleanup_secret_error=1;; esac
  done
  secret_files=
  return "$cleanup_secret_error"
}
preserve_discord_token() {
  [ -f "${rollback_discord_token_file:-}" ] || return 0
  [ ! -L "$root_dir/.env" ] || { printf '%s\n' 'environment file must not be symlink' >&2; return 1; }
  rollback_token=$(sed -n '1p' "$rollback_discord_token_file" 2>/dev/null || true)
  valid_scalar "$rollback_token" || return 1
  target_dir=$(dirname "$root_dir/.env"); temporary=$(mktemp "$target_dir/.env-rollback-discord.XXXXXX") || return 1
  awk -F= '$1 != "DISCORD_TOKEN" { print }' "$root_dir/.env" > "$temporary" || { rm -f "$temporary"; return 1; }
  printf 'DISCORD_TOKEN=%s\n' "$rollback_token" >> "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 600 "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" "$root_dir/.env" || { rm -f "$temporary"; return 1; }
}
restore_cron() {
  [ -n "${cron_snapshot:-}" ] || return 0
  [ -f "$cron_snapshot" ] || return 1
  [ ! -L "$cron_snapshot" ] || return 1
  [ "$(stat -c '%a' "$cron_snapshot" 2>/dev/null || printf 0)" = 600 ] || return 1
  valid_sha "${cron_snapshot_sha256:-}" || return 1
  [ "$(file_hash "$cron_snapshot")" = "$cron_snapshot_sha256" ] || return 1
  "$crontab_bin" "$cron_snapshot" >/dev/null 2>&1 || return 1
}
snapshot_cron() {
  cron_snapshot=$state_dir/router-cron.$maintenance_started_epoch
  if [ -f "$cron_snapshot" ]; then
    [ ! -L "$cron_snapshot" ] || return 1
    chmod 600 "$cron_snapshot" || return 1
  else
    target_dir=$(dirname "$cron_snapshot"); temporary=$(mktemp "$target_dir/.router-cron.XXXXXX") || return 1
    if ! "$crontab_bin" -l > "$temporary" 2>/dev/null; then
      rm -f "$temporary"
      return 1
    fi
    chmod 600 "$temporary" || { rm -f "$temporary"; return 1; }
    mv "$temporary" "$cron_snapshot" || { rm -f "$temporary"; return 1; }
  fi
  cron_snapshot_sha256=$(file_hash "$cron_snapshot")
  valid_sha "$cron_snapshot_sha256" || return 1
}
pause_cron() {
  [ -n "${cron_snapshot:-}" ] || snapshot_cron || return 1
  [ -f "$cron_snapshot" ] || return 1
  [ ! -L "$cron_snapshot" ] || return 1
  [ "$(stat -c '%a' "$cron_snapshot" 2>/dev/null || printf 0)" = 600 ] || return 1
  paused=${cron_snapshot}.paused
  target_dir=$(dirname "$paused"); temporary=$(mktemp "$target_dir/.router-cron-paused.XXXXXX") || return 1
  awk '/#[[:space:]]*miyabi-bot-backup[[:space:]]*$/ { next } /#[[:space:]]*miyabi-9router-key-sync[[:space:]]*$/ { next } { print }' "$cron_snapshot" > "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 600 "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" "$paused" || { rm -f "$temporary"; return 1; }
  if ! "$crontab_bin" "$paused" >/dev/null 2>&1; then
    rm -f "$paused"
    return 1
  fi
  rm -f "$paused"
}
read_now_epoch() {
  if [ -n "${ROUTER_NOW_EPOCH:-}" ]; then
    printf '%s\n' "$ROUTER_NOW_EPOCH"
  elif [ -n "${ROUTER_TEST_NOW_EPOCH:-}" ]; then
    printf '%s\n' "$ROUTER_TEST_NOW_EPOCH"
  else
    "$date_bin" +%s
  fi
}
check_deadline() {
  now_epoch=$(read_now_epoch); valid_decimal "$now_epoch" || die 'invalid current epoch'
  elapsed=$((now_epoch - maintenance_started_epoch))
  [ "$elapsed" -lt 5100 ] && [ "$elapsed" -ge 0 ]
}
run_validator() {
  if [ "$dry_run" = 1 ]; then
    candidate_container=${CANDIDATE_CONTAINER:-dry-run-candidate}
  else
    candidate_container=$(compose_candidate ps -q 9router 2>/dev/null || true)
  fi
  [ -n "$candidate_container" ] || { printf '%s\n' 'candidate container missing' >&2; return 1; }
  export CANDIDATE_URL="http://127.0.0.1:$candidate_port" CANDIDATE_CONTAINER="$candidate_container"
  export CANDIDATE_IMAGE="$new_router_image" CANDIDATE_VOLUME="$candidate_volume"
  export CANDIDATE_PASSWORD_FILE="$dashboard_password_file" CANDIDATE_INITIAL_ENV_FILE="$candidate_initial_env" CANDIDATE_API_KEY_FILE="$candidate_api_key_file"
  export CANDIDATE_GEMINI_KEY_FILE="$gemini_key_file" CANDIDATE_CLIENT_KEY_ID_FILE="$selected_client_key_file"
  export CANDIDATE_ENV_FILE="$candidate_env"
  provisioner=${ROUTER_PROVISION_CMD:-$root_dir/ops/provision-9router-candidate.sh}
  if [ -x "$provisioner" ]; then
    "$provisioner" || return 1
  elif [ "$dry_run" != 1 ]; then
    printf '%s\n' 'candidate provisioner missing' >&2
    return 1
  fi
  assert_private_artifact "$candidate_api_key_file" "" || return 1
  generated_client_key=$(cat "$candidate_api_key_file") || return 1
  printf '%s' "$generated_client_key" | grep -Eq '^sk-[a-z0-9-]{8,}$' || { printf '%s\n' 'provisioner returned invalid client key' >&2; return 1; }
  candidate_api_key_sha256=$(file_hash "$candidate_api_key_file")
  manifest_set candidate_api_key_sha256 "$candidate_api_key_sha256" || return 1
  write_candidate_env || return 1
  candidate_env_sha256=$(file_hash "$candidate_env") || return 1
  candidate_initial_env_sha256=$(file_hash "$candidate_initial_env") || return 1
  manifest_set candidate_env_sha256 "$candidate_env_sha256" || return 1
  new_ai_key_sha256=$(value_hash "$generated_client_key")
  manifest_set new_ai_key_sha256 "$new_ai_key_sha256" || return 1
  if [ -n "${ROUTER_VALIDATE_CMD:-}" ]; then
    sh -c "$ROUTER_VALIDATE_CMD" || return 1
  else
    validator=${ROUTER_VALIDATOR:-$root_dir/ops/validate-9router-candidate.sh}
    [ -x "$validator" ] || { printf '%s\n' 'candidate validator missing' >&2; return 1; }
    "$validator" || return 1
  fi
  assert_private_artifact "$selected_client_key_file" "" || return 1
  selected_client_key_id=$(sed -n '1p' "$selected_client_key_file") || return 1
  valid_uuid "$selected_client_key_id" || { printf '%s\n' 'validator must return an active client key UUID' >&2; return 1; }
  if [ -n "${ROUTER_CANARY_CMD:-}" ]; then
    sh -c "$ROUTER_CANARY_CMD" || return 1
  fi
}
write_minimal_env() {
  target=$1
  [ ! -L "$target" ] || return 1
  target_dir=$(dirname "$target"); temporary=$(mktemp "$target_dir/.router-active-env.XXXXXX") || return 1
  admin_users=$(env_value_from "$env_snapshot" ADMIN_USER_IDS); settings_users=$(env_value_from "$env_snapshot" AI_SETTINGS_USER_IDS)
  admin_roles=$(env_value_from "$env_snapshot" ADMIN_ROLE_IDS); settings_roles=$(env_value_from "$env_snapshot" AI_SETTINGS_ROLE_IDS)
  {
    printf 'DISCORD_TOKEN=%s\n' "$new_discord_token"
    printf 'DISCORD_CLIENT_ID=%s\n' "$(env_value_from "$env_snapshot" DISCORD_CLIENT_ID)"
    printf 'DISCORD_GUILD_ID=%s\n' "$(env_value_from "$env_snapshot" DISCORD_GUILD_ID)"
    [ -z "$admin_users" ] || printf 'ADMIN_USER_IDS=%s\n' "$admin_users"
    [ -z "$admin_roles" ] || printf 'ADMIN_ROLE_IDS=%s\n' "$admin_roles"
    [ -z "$settings_users" ] || printf 'AI_SETTINGS_USER_IDS=%s\n' "$settings_users"
    [ -z "$settings_roles" ] || printf 'AI_SETTINGS_ROLE_IDS=%s\n' "$settings_roles"
    printf 'NINE_ROUTER_JWT_SECRET=%s\n' "$new_jwt_secret"
    printf 'NINE_ROUTER_API_KEY_SECRET=%s\n' "$new_api_secret"
    printf 'NINE_ROUTER_MACHINE_ID_SALT=%s\n' "$new_machine_salt"
    printf 'AI_API_KEY=%s\n' "$generated_client_key"
    printf 'BOT_IMAGE=%s\n' "$new_bot_image"
    printf 'BOT_IMAGE_PREVIOUS=%s\n' "$old_bot_image"
  } > "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 600 "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" "$target" || { rm -f "$temporary"; return 1; }
}
restore_env() {
  [ -f "$env_snapshot" ] || { printf '%s\n' 'env snapshot missing' >&2; return 1; }
  [ ! -L "$env_snapshot" ] || { printf '%s\n' 'environment snapshot must not be symlink' >&2; return 1; }
  [ ! -L "$root_dir/.env" ] || { printf '%s\n' 'environment file must not be symlink' >&2; return 1; }
  [ "$(file_hash "$env_snapshot")" = "$env_snapshot_sha256" ] || { printf '%s\n' 'env snapshot hash mismatch' >&2; return 1; }
  target_dir=$(dirname "$root_dir/.env"); temporary=$(mktemp "$target_dir/.env-rollback.XXXXXX") || return 1
  cp -p "$env_snapshot" "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 600 "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" "$root_dir/.env" || { rm -f "$temporary"; return 1; }
}
build_new_bot() {
  if [ "${ROUTER_RELEASE_SKIP_BUILD:-0}" = 1 ] || [ "$dry_run" = 1 ]; then return; fi
  if "$docker_bin" image inspect "$new_bot_image" >/dev/null 2>&1; then return; fi
  "$docker_bin" build --build-arg "VCS_REF=$head_sha" -t "$new_bot_image" "$root_dir"
}
prepare_abort() {
  [ "${prepare_active:-0}" = 1 ] || return
  cleanup_error=0
  cleanup_candidate_runtime || true
  for artifact_path in "${candidate_env:-}" "${candidate_override:-}"; do
    [ -z "$artifact_path" ] && continue
    case "$artifact_path" in
      "$state_dir"/*) rm -f "$artifact_path" || cleanup_error=1;;
      *) cleanup_error=1;;
    esac
  done
  if [ -n "${new_volume:-}" ] && volume_exists "$new_volume"; then
    remove_volume_exact "$new_volume" || cleanup_error=1
  fi
  cleanup_secret_files || cleanup_error=1
  restore_cron || cleanup_error=1
  if [ -n "${manifest_path:-}" ] && [ -f "$manifest_path" ]; then
    if [ "$cleanup_error" -eq 0 ]; then
      manifest_set state failed || true
    else
      manifest_set cleanup_error prepare-abort || true
    fi
  fi
}
cutover_abort() {
  [ "${cutover_active:-0}" = 1 ] || return
  load_manifest || return
  case "$state" in validated|preparing) rollback_locked || true;; esac
}
prepare() {
  [ ! -L "$manifest_path" ] || die 'manifest path must not be symlink'
  if [ -e "$manifest_path" ]; then load_manifest; case "$state" in rolled_back|failed) ;; *) die 'active release exists';; esac; fi
  assert_main_synced; [ -f "$root_dir/.env" ] || die '.env required'; [ ! -L "$root_dir/.env" ] || die 'environment file must not be symlink'; [ "$(stat -c '%a' "$root_dir/.env" 2>/dev/null || printf 0)" = 600 ] || die 'environment file must be mode 600'
  if [ "$dry_run" = 1 ]; then
    expected_production_port=${ROUTER_PRODUCTION_PORT:-20128}; expected_candidate_port=${ROUTER_CANDIDATE_PORT:-20129}
  fi
  [ "$production_port" = "$expected_production_port" ] || die 'production port is not fixed loopback port'
  [ "$candidate_port" = "$expected_candidate_port" ] || die 'candidate port is not fixed isolation port'
  valid_port "$candidate_port" || die 'candidate port invalid'; [ "$candidate_port" != "$production_port" ] || die 'candidate port equals production'
  acquire_lock
  prepare_active=1
  trap prepare_abort EXIT INT TERM
  assert_backup_cron_lock || die 'backup cron must use nonblocking flock on OPS_LOCK_FILE'
  # The maintenance SLA starts as soon as the shared operations lock is held.
  # Record it before reading or validating any replacement secret so all
  # preflight/build/provision work is included in the 85-minute window.
  maintenance_started_epoch=$(read_now_epoch); valid_decimal "$maintenance_started_epoch" || die 'invalid maintenance epoch'
  maintenance_started_at=$("$date_bin" -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s\n' "$maintenance_started_epoch")
  # Capture the live cron before any backup, build, or candidate-secret mutation.
  # A read failure is fatal and leaves the existing crontab untouched.
  snapshot_cron || die 'cron snapshot failed'
  new_discord_token=$(secret_line 1); new_gemini_key=$(secret_line 2); dashboard_password=$(secret_line 3)
  [ "${#dashboard_password}" -ge 16 ] || die 'dashboard password too short'
  check_deadline || die 'maintenance window exceeded 85 minutes'
  env_snapshot=$state_dir/router-env.$maintenance_started_epoch; cp -p "$root_dir/.env" "$env_snapshot"; chmod 600 "$env_snapshot"; env_snapshot_sha256=$(file_hash "$env_snapshot"); valid_sha "$env_snapshot_sha256" || die 'env hash invalid'
  discord_token_file=$state_dir/router-discord-token.$maintenance_started_epoch; write_secret_file "$discord_token_file" "$new_discord_token"; secret_files="$discord_token_file"
  validate_discord_token || die 'Discord token validation failed'
  inspect_router; old_bot_image=$(env_value BOT_IMAGE); valid_image "$old_bot_image" || die 'old bot image invalid'
  head_sha=$("$git_bin" rev-parse HEAD 2>/dev/null || true); valid_sha40 "$head_sha" || head_sha=${HEAD_SHA:-0000000000000000000000000000000000000000}
  expected_new_bot_image=miyabi-bot:git-$head_sha
  if [ "$dry_run" != 1 ] && [ "$test_mode" != 1 ] && [ -n "${NEW_BOT_IMAGE:-}" ] && [ "$NEW_BOT_IMAGE" != "$expected_new_bot_image" ]; then
    die 'NEW_BOT_IMAGE must match the current main revision'
  fi
  new_bot_image=${NEW_BOT_IMAGE:-$expected_new_bot_image}; valid_image "$new_bot_image" || die 'new bot image invalid'
  new_volume=$expected_new_volume
  if [ "$dry_run" = 1 ] && [ -n "${NEW_ROUTER_VOLUME:-}" ]; then new_volume=$NEW_ROUTER_VOLUME; fi
  valid_volume "$new_volume" || die 'new volume invalid'; [ "$new_volume" != "$old_volume" ] || die 'new volume equals old'
  if volume_exists "$new_volume"; then die 'new production volume already exists'; fi
  old_bot_image=$(env_value_from "$env_snapshot" BOT_IMAGE); check_deadline || die 'maintenance window exceeded 85 minutes'; backup_database; check_deadline || die 'maintenance window exceeded 85 minutes'; build_new_bot; check_deadline || die 'maintenance window exceeded 85 minutes'
  candidate_project=horo-discord-bot-candidate-$maintenance_started_epoch
  candidate_volume=$new_volume
  candidate_override=$state_dir/router-candidate-compose.$maintenance_started_epoch.yml; active_override=$state_dir/router-active-compose.yml
  new_jwt_secret=$(random_hex 32); new_api_secret=$(random_hex 32); new_machine_salt=$(random_hex 32)
  generated_client_key=sk-$(random_hex 24)
  gemini_key_file=$state_dir/router-gemini-key.$maintenance_started_epoch; write_secret_file "$gemini_key_file" "$new_gemini_key"
  dashboard_password_file=$state_dir/router-dashboard-password.$maintenance_started_epoch; write_secret_file "$dashboard_password_file" "$dashboard_password"
  candidate_initial_env=$state_dir/router-initial-env.$maintenance_started_epoch; write_initial_env_file "$candidate_initial_env" "$dashboard_password"
  candidate_api_key_file=$state_dir/router-candidate-api-key.$maintenance_started_epoch; write_secret_file "$candidate_api_key_file" "$generated_client_key"
  selected_client_key_file=$state_dir/router-selected-client-id.$maintenance_started_epoch; : > "$selected_client_key_file"; chmod 600 "$selected_client_key_file"
  secret_files="$discord_token_file $gemini_key_file $dashboard_password_file $candidate_initial_env $candidate_api_key_file $selected_client_key_file"
  check_deadline || die 'maintenance window exceeded 85 minutes'
  [ -f "$root_dir/docker-compose.yml" ] || die 'docker compose file missing'
  [ ! -L "$root_dir/docker-compose.yml" ] || die 'docker compose file must not be symlink'
  compose_sha=$(file_hash "$root_dir/docker-compose.yml"); valid_sha "$compose_sha" || die 'compose hash invalid'
  old_ai_key_sha256=$(value_hash "$(env_value_from "$env_snapshot" AI_API_KEY)"); new_ai_key_sha256=$(value_hash "$generated_client_key")
  write_candidate_env
  secret_files="$discord_token_file $gemini_key_file $dashboard_password_file $candidate_initial_env $candidate_api_key_file $selected_client_key_file $candidate_env"
  write_override "$candidate_override" "$new_router_image" "$candidate_volume" "$candidate_port" "$candidate_initial_env"
  candidate_env_sha256=$(file_hash "$candidate_env"); candidate_override_sha256=$(file_hash "$candidate_override")
  discord_token_sha256=$(file_hash "$discord_token_file"); gemini_key_sha256=$(file_hash "$gemini_key_file")
  dashboard_password_sha256=$(file_hash "$dashboard_password_file"); candidate_initial_env_sha256=$(file_hash "$candidate_initial_env"); candidate_api_key_sha256=$(file_hash "$candidate_api_key_file")
  manifest_write preparing "old_router_image=$old_router_image" "new_router_image=$new_router_image" "old_router_revision=$old_router_revision" "new_router_revision=$new_router_revision" "old_volume=$old_volume" "new_volume=$new_volume" "candidate_volume=$candidate_volume" "old_bot_image=$old_bot_image" "new_bot_image=$new_bot_image" "db_backup=$db_backup" "db_backup_sha256=$db_backup_sha256" "env_snapshot=$env_snapshot" "env_snapshot_sha256=$env_snapshot_sha256" "candidate_env=$candidate_env" "candidate_env_sha256=$candidate_env_sha256" "candidate_initial_env=$candidate_initial_env" "candidate_initial_env_sha256=$candidate_initial_env_sha256" "candidate_override=$candidate_override" "override=$candidate_override" "candidate_override_sha256=$candidate_override_sha256" "active_override=$active_override" "cron_snapshot=$cron_snapshot" "cron_snapshot_sha256=$cron_snapshot_sha256" "maintenance_started_at=$maintenance_started_at" "maintenance_started_epoch=$maintenance_started_epoch" "candidate_port=$candidate_port" "production_port=$production_port" "compose_sha=$compose_sha" "selected_client_key_id=none" "volume_swapped=0" "old_ai_key_sha256=$old_ai_key_sha256" "new_ai_key_sha256=$new_ai_key_sha256" "secrets_cleaned=0" "active_discord_token_sha256=none" "discord_token_file=$discord_token_file" "discord_token_sha256=$discord_token_sha256" "gemini_key_file=$gemini_key_file" "gemini_key_sha256=$gemini_key_sha256" "dashboard_password_file=$dashboard_password_file" "dashboard_password_sha256=$dashboard_password_sha256" "candidate_api_key_file=$candidate_api_key_file" "candidate_api_key_sha256=$candidate_api_key_sha256" "selected_client_key_file=$selected_client_key_file"
  watchdog_start || die 'maintenance watchdog start failed'
  pause_cron || die 'cron pause failed'
  manifest_set state prepared
  if [ "$dry_run" = 1 ]; then
    run_validator
    check_deadline || die 'maintenance window exceeded 85 minutes'
    manifest_set selected_client_key_id "$selected_client_key_id"
    manifest_set state validated
    cleanup_secret_files; prepare_active=0; trap - EXIT INT TERM
    printf 'prepared candidate (dry-run)\n'
    return
  fi
  if ! compose_candidate config --quiet || ! compose_candidate up -d --force-recreate 9router || ! wait_healthy_candidate || ! run_validator; then
    cleanup_error=0
    restore_cron || cleanup_error=1
    cleanup_candidate_runtime || cleanup_error=1
    if volume_exists "$new_volume"; then
      remove_volume_exact "$new_volume" || cleanup_error=1
    fi
    rm -f "$candidate_env" "$candidate_override" || cleanup_error=1
    cleanup_secret_files || cleanup_error=1
    [ "$cleanup_error" -eq 0 ] || { manifest_set cleanup_error candidate-cleanup || true; die 'candidate cleanup failed'; }
    die 'candidate validation failed'
  fi
  check_deadline || die 'maintenance window exceeded 85 minutes'
  manifest_set selected_client_key_id "$selected_client_key_id"; manifest_set state validated
  prepare_active=0; trap - EXIT INT TERM; printf 'candidate validated\n'
}
write_active_env() {
  active_env_target=$root_dir/.env.router-cutover
  [ ! -L "$root_dir/.env" ] || return 1
  write_minimal_env "$active_env_target" || { rm -f "$active_env_target"; return 1; }
  mv "$active_env_target" "$root_dir/.env" || { rm -f "$active_env_target"; return 1; }
  chmod 600 "$root_dir/.env" || return 1
}
swap_volume() {
  [ "$dry_run" = 1 ] && { volume_swapped=1; return; }
  volume_exists "$new_volume" || die 'candidate production volume was not created'
  volume_swapped=1
}
restore_volume_swap() {
  [ "${volume_swapped:-0}" = 1 ] || return
  [ "$dry_run" = 1 ] && { volume_swapped=0; return; }
  refs=$("$docker_bin" ps -a --filter "volume=$new_volume" -q 2>/dev/null || true); [ -z "$refs" ] || die "new volume still referenced: $new_volume"
  remove_volume_exact "$new_volume"; volume_swapped=0
}
restore_database() {
  case "$db_backup" in "$root_dir/backups/"*) ;; *) printf '%s\n' 'db backup path invalid' >&2; return 1;; esac
  case "$db_backup" in *'/../'*|*/..|*'/./'*|*/.) printf '%s\n' 'db backup path traversal' >&2; return 1;; esac
  [ -f "$db_backup" ] || { printf '%s\n' 'db backup missing' >&2; return 1; }
  valid_sha "$db_backup_sha256" || { printf '%s\n' 'db backup hash missing' >&2; return 1; }
  [ "$(file_hash "$db_backup")" = "$db_backup_sha256" ] || { printf '%s\n' 'db backup hash mismatch' >&2; return 1; }
  [ "$dry_run" = 1 ] && return 0
  compose_active stop bot-prod >/dev/null 2>&1 || true
  rm -f "$root_dir/data/bot.sqlite-wal" "$root_dir/data/bot.sqlite-shm" || return 1
  [ ! -L "$root_dir/data/bot.sqlite" ] || { printf '%s\n' 'database target must not be symlink' >&2; return 1; }
  target_dir=$(dirname "$root_dir/data/bot.sqlite"); temporary=$(mktemp "$target_dir/.bot.sqlite.restore.XXXXXX") || return 1
  cp -p "$db_backup" "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 600 "$temporary" || { rm -f "$temporary"; return 1; }
  mv "$temporary" "$root_dir/data/bot.sqlite" || { rm -f "$temporary"; return 1; }
}
apply_router_image() {
  image=$1; volume=$2; rollback_override=$(mktemp "$state_dir/.router-rollback.XXXXXX") || return 1
  rm -f "$rollback_override"
  write_override "$rollback_override" "$image" "$volume" "$production_port" || return 1
  if [ "$dry_run" != 1 ]; then
    previous_active=${active_override:-}
    active_override=$rollback_override
    "$docker_bin" compose --project-name horo-discord-bot -f "$root_dir/docker-compose.yml" -f "$rollback_override" up -d --force-recreate 9router bot-prod &&
      wait_healthy_active 9router && wait_healthy_active bot-prod || {
        active_override=$previous_active
        rm -f "$rollback_override"
        return 1
      }
    active_override=$previous_active
  fi
  rm -f "$rollback_override"
}
perform_sync() {
  [ "$dry_run" = 1 ] && return
  sync_cmd=${ROUTER_SYNC_KEY_CMD:-}
  [ -n "$sync_cmd" ] || [ ! -x "$root_dir/ops/bootstrap-9router.sh" ] || sync_cmd="sh $root_dir/ops/bootstrap-9router.sh sync-key"
  [ -n "$sync_cmd" ] || return
  MIYABI_OPS_LOCK_HELD=1 sh -c "$sync_cmd"
}
write_selected_client_key() {
  valid_uuid "$selected_client_key_id" || die 'selected client key id invalid'
  [ "$dry_run" = 1 ] && return 0
  compose_active exec -T bot-prod node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/app/data/bot.sqlite"); db.prepare("INSERT INTO ai_runtime_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("ai_9router_key_id",process.argv[1]); db.close();' "$selected_client_key_id" || return 1
}
production_validate() {
  [ "$dry_run" = 1 ] && return
  production_container=$(compose_active ps -q 9router 2>/dev/null || true)
  [ -n "$production_container" ] || { printf '%s\n' 'production router container missing' >&2; return 1; }
  export PRODUCTION_URL="http://127.0.0.1:$production_port" PRODUCTION_CONTAINER="$production_container"
  export PRODUCTION_IMAGE="$new_router_image" PRODUCTION_VOLUME="$new_volume"
  export PRODUCTION_CLIENT_KEY_ID="${selected_client_key_id:-}"
  if [ -n "${ROUTER_PRODUCTION_VALIDATE_CMD:-}" ]; then
    sh -c "$ROUTER_PRODUCTION_VALIDATE_CMD" || return 1
  else
    validator=${ROUTER_VALIDATOR:-$root_dir/ops/validate-9router-candidate.sh}
    [ -x "$validator" ] || { printf '%s\n' 'production smoke validator missing' >&2; return 1; }
    export PRODUCTION_VALIDATION=1 CANDIDATE_URL="$PRODUCTION_URL" CANDIDATE_CONTAINER="$production_container" CANDIDATE_IMAGE="$new_router_image" CANDIDATE_VOLUME="$new_volume" CANDIDATE_PASSWORD_FILE="$dashboard_password_file" CANDIDATE_GEMINI_KEY_FILE="$gemini_key_file" CANDIDATE_API_KEY_FILE="$candidate_api_key_file" CANDIDATE_CLIENT_KEY_ID_FILE="$selected_client_key_file"
    "$validator" || return 1
  fi
  if [ -n "${ROUTER_FORMAL_CANARY_CMD:-}" ]; then
    export PRODUCTION_VALIDATION=1 CANDIDATE_URL="http://127.0.0.1:$production_port" CANDIDATE_CONTAINER="$production_container" CANDIDATE_IMAGE="$new_router_image" CANDIDATE_VOLUME="$new_volume"
    sh -c "$ROUTER_FORMAL_CANARY_CMD" || return 1
  elif [ -n "${ROUTER_PRODUCTION_CANARY_CMD:-}" ]; then
    sh -c "$ROUTER_PRODUCTION_CANARY_CMD" || return 1
  fi
}
cutover() {
  acquire_lock; load_manifest; [ "$state" = validated ] || die "invalid cutover state: $state"
  cutover_active=1; trap cutover_abort EXIT INT TERM
  check_deadline || { rollback_locked; die 'maintenance window exceeded 85 minutes'; }
  validate_manifest_artifacts
  [ "$(file_hash "$root_dir/.env")" = "$env_snapshot_sha256" ] || die 'active environment changed during candidate validation'
  [ -f "$candidate_env" ] && [ -f "$candidate_override" ] || die 'candidate artifacts missing'
  new_discord_token=$(env_value_from "$candidate_env" DISCORD_TOKEN); generated_client_key=$(env_value_from "$candidate_env" AI_API_KEY)
  new_gemini_key=
  printf '%s' "$generated_client_key" | grep -Eq '^sk-[a-z0-9-]{8,}$' || die 'candidate client key missing or invalid'
  valid_uuid "$selected_client_key_id" || die 'selected client key id invalid'
  new_jwt_secret=$(env_value_from "$candidate_env" NINE_ROUTER_JWT_SECRET); new_api_secret=$(env_value_from "$candidate_env" NINE_ROUTER_API_KEY_SECRET); new_machine_salt=$(env_value_from "$candidate_env" NINE_ROUTER_MACHINE_ID_SALT)
  candidate_project=horo-discord-bot-candidate-$maintenance_started_epoch
  check_deadline || { rollback_locked; die 'maintenance window exceeded 85 minutes'; }
  manifest_set phase stopping
  if ! cleanup_candidate_runtime; then rollback_locked; die 'candidate runtime cleanup failed'; fi
  if ! compose_active stop 9router bot-prod >/dev/null 2>&1; then rollback_locked; die 'production stop failed'; fi
  check_deadline || { rollback_locked; die 'maintenance window exceeded 85 minutes'; }
  if ! swap_volume; then rollback_locked; die 'volume switch failed'; fi
  manifest_set volume_swapped "$volume_swapped"
  write_override "$active_override" "$new_router_image" "$new_volume" "$production_port"
  manifest_set phase volume-ready
  if ! write_active_env; then rollback_locked; die 'production env write failed'; fi
  manifest_set phase environment-written
  if ! compose_active up -d --force-recreate 9router || ! wait_healthy_active 9router; then rollback_locked; die 'production router health failed'; fi
  if ! compose_active up -d bot-prod || ! wait_healthy_active bot-prod; then
    rollback_locked; die 'production bot health failed'
  fi
  manifest_set phase healthy
  check_deadline || { rollback_locked; die 'maintenance window exceeded 85 minutes'; }
  write_selected_client_key
  if ! perform_sync; then rollback_locked; die 'key sync failed'; fi
  manifest_set phase synced
  check_deadline || { rollback_locked; die 'maintenance window exceeded 85 minutes'; }
  production_validate || { rollback_locked; die 'production smoke validation failed'; }
  manifest_set phase formal-smoke
  check_deadline || { rollback_locked; die 'maintenance window exceeded 85 minutes'; }
  valid_uuid "$selected_client_key_id" || { rollback_locked; die 'selected client key id invalid'; }
  manifest_set selected_client_key_id "$selected_client_key_id"; manifest_set volume_swapped "$volume_swapped"
  active_discord_token_sha256=$(value_hash "$new_discord_token"); valid_sha "$active_discord_token_sha256" || { rollback_locked; die 'active Discord token hash invalid'; }
  manifest_set active_discord_token_sha256 "$active_discord_token_sha256"
  if ! cleanup_secret_files; then rollback_locked; die 'secret cleanup failed'; fi
    manifest_set secrets_cleaned 1; manifest_set state cutover
  cutover_active=0; trap - EXIT INT TERM; printf 'router cutover complete\n'
}
rollback_locked() {
  saved_health_attempts=$health_attempts
  rollback_timeout=${ROLLBACK_HEALTH_TIMEOUT:-300}; valid_decimal "$rollback_timeout" || rollback_timeout=300
  [ "$rollback_timeout" -le 300 ] 2>/dev/null || rollback_timeout=300
  [ "$rollback_timeout" -ge 5 ] 2>/dev/null || rollback_timeout=5
  rollback_health_attempts=${ROLLBACK_HEALTH_ATTEMPTS:-$((rollback_timeout / 2))}
  valid_decimal "$rollback_health_attempts" || rollback_health_attempts=150
  [ "$rollback_health_attempts" -le 150 ] 2>/dev/null || rollback_health_attempts=150
  [ "$rollback_health_attempts" -gt 0 ] 2>/dev/null || rollback_health_attempts=1
  health_attempts=$rollback_health_attempts
  rollback_started_epoch=$(read_now_epoch); valid_decimal "$rollback_started_epoch" || rollback_started_epoch=0
  rollback_deadline_epoch=$((rollback_started_epoch + rollback_timeout))
  rollback_in_progress=1
  rollback_error=0
  load_manifest || { rollback_in_progress=0; health_attempts=$saved_health_attempts; return 1; }
  candidate_project=horo-discord-bot-candidate-$maintenance_started_epoch
  rollback_discord_token_file=$state_dir/router-rollback-discord-token.$$
  if [ ! -L "$root_dir/.env" ]; then
    active_discord_token=$(env_value DISCORD_TOKEN || true)
    if [ -f "$discord_token_file" ] && [ ! -L "$discord_token_file" ] && [ "$(stat -c '%a' "$discord_token_file" 2>/dev/null || printf 0)" = 600 ] && [ "$(file_hash "$discord_token_file")" = "$discord_token_sha256" ]; then
      candidate_discord_token=$(sed -n '1p' "$discord_token_file" 2>/dev/null || true)
      if valid_scalar "$candidate_discord_token"; then
        write_secret_file "$rollback_discord_token_file" "$candidate_discord_token" || rollback_error=1
      fi
    elif valid_scalar "$active_discord_token" && [ "$active_discord_token_sha256" != none ] && [ "$(value_hash "$active_discord_token")" = "$active_discord_token_sha256" ]; then
      write_secret_file "$rollback_discord_token_file" "$active_discord_token" || rollback_error=1
    fi
  fi
  secret_files="${secret_files:-} $rollback_discord_token_file"
  health_deadline_ok || rollback_error=1
  cleanup_candidate_runtime || rollback_error=1
  health_deadline_ok || rollback_error=1
  prod_stopped=1
  if ! compose_active stop 9router bot-prod >/dev/null 2>&1; then prod_stopped=0; rollback_error=1; fi
  health_deadline_ok || rollback_error=1
  if [ -n "${candidate_volume:-}" ] && volume_exists "$candidate_volume"; then
    remove_volume_exact "$candidate_volume" || rollback_error=1
    [ "$rollback_error" -ne 0 ] || { volume_swapped=0; manifest_set volume_swapped 0 || rollback_error=1; }
  fi
  health_deadline_ok || rollback_error=1
  if [ "$prod_stopped" -eq 1 ]; then
    restore_database || rollback_error=1
  fi
  restore_env || rollback_error=1
  preserve_discord_token || rollback_error=1
  health_deadline_ok || rollback_error=1
  if ! apply_router_image "$old_router_image" "$old_volume"; then rollback_error=1; fi
  health_deadline_ok || rollback_error=1
  [ -z "${active_override:-}" ] || rm -f "$active_override"
  rm -f "${candidate_env:-}" "${candidate_override:-}"
  restore_cron || rollback_error=1
  cleanup_secret_files || rollback_error=1
  health_deadline_ok || rollback_error=1
  rollback_in_progress=0
  health_attempts=$saved_health_attempts
  if [ "$rollback_error" -eq 0 ]; then manifest_set state rolled_back; printf 'router release rolled back\n' >&2; return 0; fi
  compose_active stop bot-prod >/dev/null 2>&1 || true; printf 'router rollback failed; bot stopped; manifest retained\n' >&2; return 1
}
rollback() {
  acquire_lock; load_manifest
  [ "$state" != finalizing ] || die 'cannot rollback a finalizing release'
  rollback_locked || exit 1
}
cleanup_old_runtime() {
  export ROUTER_OLD_VOLUME="$old_volume" ROUTER_OLD_ROUTER_IMAGE="$old_router_image"
  if [ -n "${ROUTER_CLEANUP_CMD:-}" ]; then sh -c "$ROUTER_CLEANUP_CMD" || return 1; return 0; fi
  [ "$dry_run" = 1 ] && return 0
  volume_exists "$old_volume" || return 0
  "$docker_bin" run --rm --entrypoint /bin/sh --mount "source=$old_volume,target=/data" "$old_router_image" -c 'set -eu
    node -e "const {DatabaseSync}=require(\"node:sqlite\"); const db=new DatabaseSync(\"/data/db/data.sqlite\"); db.exec(\"DELETE FROM requestDetails; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);\"); const n=db.prepare(\"SELECT count(*) AS n FROM requestDetails\").get().n; const i=db.prepare(\"PRAGMA integrity_check\").get().integrity_check; const f=db.prepare(\"PRAGMA foreign_key_check\").all(); db.close(); if(n!==0 || i!==\"ok\" || f.length!==0) process.exit(1);"
    rm -f /data/logs/requestDetails.log /data/logs/payload.log /data/logs/requests.log
  ' >/dev/null || return 1
  if [ -n "${ROUTER_MARKER_CHECK_CMD:-}" ]; then sh -c "$ROUTER_MARKER_CHECK_CMD" || return 1; fi
}
watchdog_start() {
  if [ "${ROUTER_RELEASE_DISABLE_WATCHDOG:-0}" = 1 ]; then
    [ "$dry_run" = 1 ] || [ "$test_mode" = 1 ] || return 1
    return 0
  fi
  watchdog_started_epoch=$(read_now_epoch); valid_decimal "$watchdog_started_epoch" || return 1
  manifest_set watchdog_pid none || return 1
  manifest_set watchdog_started_epoch "$watchdog_started_epoch" || return 1
  (
    exec 9>&-
    exec env -i \
      PATH="${PATH:-/usr/bin:/bin}" \
      ROOT_DIR="$root_dir" STATE_DIR="$state_dir" MANIFEST_PATH="$manifest_path" \
      OPS_LOCK_FILE="$ops_lock_file" DOCKER_BIN="$docker_bin" CRONTAB_BIN="$crontab_bin" \
      SHA256_BIN="$sha_bin" DATE_BIN="$date_bin" \
      ROUTER_RELEASE_DRY_RUN="$dry_run" ROUTER_RELEASE_TEST_MODE="$test_mode" \
      ROUTER_RELEASE_IMAGE="$expected_router_image" ROUTER_RELEASE_REVISION="$expected_router_revision" \
      ROUTER_PRODUCTION_PORT="$production_port" ROUTER_CANDIDATE_PORT="$candidate_port" \
      ROUTER_WATCHDOG_POLL_SECONDS="${ROUTER_WATCHDOG_POLL_SECONDS:-15}" \
      ROUTER_WATCHDOG_ONCE="${ROUTER_WATCHDOG_ONCE:-0}" ROUTER_RELEASE_SCRIPT="$release_script" \
      nohup sh "$release_script" watchdog
  ) >/dev/null 2>&1 &
  watchdog_pid=$!
  valid_decimal "$watchdog_pid" || return 1
  manifest_set watchdog_pid "$watchdog_pid" || return 1
}
watchdog() {
  while :; do
    [ -f "$manifest_path" ] || return 0
    if ! load_manifest; then return 0; fi
    case "$state" in failed|rolled_back|finalizing) return 0;; preparing|prepared|validated|cutover) :;; *) return 0;; esac
    now_epoch=$(read_now_epoch); valid_decimal "$now_epoch" || return 0
    start_epoch=${maintenance_started_epoch:-}
    valid_decimal "$start_epoch" || return 0
    if [ $((now_epoch - start_epoch)) -ge 5100 ]; then
      acquire_lock
      if load_manifest; then
        case "$state" in failed|rolled_back|finalizing) return 0;; preparing|prepared|validated|cutover) rollback_locked || return 1;; esac
      fi
      return 0
    fi
    [ "${ROUTER_WATCHDOG_ONCE:-0}" = 1 ] && return 0
    poll=${ROUTER_WATCHDOG_POLL_SECONDS:-15}; valid_decimal "$poll" || poll=15
    [ "$poll" -ge 1 ] 2>/dev/null || poll=1
    [ "$poll" -le 60 ] 2>/dev/null || poll=60
    sleep "$poll"
  done
}
assert_no_volume_refs() {
  volume=$1; [ "$dry_run" = 1 ] && return
  refs=$("$docker_bin" ps -a --filter "volume=$volume" -q 2>/dev/null || true); [ -z "$refs" ] || die "volume references remain: $volume"
}
remove_finalize_artifact() {
  finalize_artifact=$1
  [ -n "$finalize_artifact" ] || return 0
  state_path "$finalize_artifact" || return 1
  [ "$finalize_artifact" != "$manifest_path" ] || return 1
  if [ -e "$finalize_artifact" ] || [ -L "$finalize_artifact" ]; then
    [ ! -L "$finalize_artifact" ] || return 1
    rm -f "$finalize_artifact" || return 1
  fi
}
finalize() {
  acquire_lock; load_manifest; case "$state" in cutover|finalizing) ;; *) die "invalid finalize state: $state";; esac
  [ "${ROUTER_RELEASE_CONFIRM:-}" = YES ] || die 'finalize requires explicit post-smoke confirmation'
  [ "${ROUTER_OLD_GEMINI_REVOKED:-}" = YES ] || die 'finalize requires confirmation that the old Gemini key was revoked'
  [ "$state" = cutover ] && [ -n "$finalize_phase" ] && die 'cutover manifest has unexpected finalize phase'
  if [ -z "$finalize_phase" ]; then
    validate_manifest_artifacts
    manifest_set state finalizing
    manifest_set finalize_phase core-validated
    finalize_phase=core-validated
  fi
  if [ "$finalize_phase" = core-validated ]; then
    restore_cron || die 'cron restore failed'
    manifest_set finalize_phase cron-restored
    finalize_phase=cron-restored
  fi
  if [ "$finalize_phase" = cron-restored ]; then
    assert_no_volume_refs "$old_volume"
    cleanup_old_runtime || die 'old runtime cleanup failed'
    assert_no_volume_refs "$old_volume"
    manifest_set finalize_phase runtime-cleaned
    finalize_phase=runtime-cleaned
  fi
  if [ "$finalize_phase" = runtime-cleaned ]; then
    [ -z "${candidate_volume:-}" ] || [ "$candidate_volume" = "$new_volume" ] || remove_volume_exact "$candidate_volume" || die 'candidate volume removal failed'
    if volume_exists "$old_volume"; then remove_volume_exact "$old_volume" || die 'old runtime volume removal failed'; fi
    assert_no_volume_refs "$old_volume"
    manifest_set finalize_phase old-volume-removed
    finalize_phase=old-volume-removed
  fi
  if [ "$finalize_phase" = old-volume-removed ]; then
    cleanup_secret_files || die 'secret cleanup failed'
    remove_finalize_artifact "$candidate_env" || die 'candidate environment cleanup failed'
    remove_finalize_artifact "$candidate_initial_env" || die 'initial environment cleanup failed'
    remove_finalize_artifact "$candidate_override" || die 'candidate override cleanup failed'
    remove_finalize_artifact "$active_override" || die 'active override cleanup failed'
    remove_finalize_artifact "$env_snapshot" || die 'environment snapshot cleanup failed'
    remove_finalize_artifact "$cron_snapshot" || die 'cron snapshot cleanup failed'
    manifest_set finalize_phase artifacts-cleaned
    finalize_phase=artifacts-cleaned
  fi
  if [ "$finalize_phase" = artifacts-cleaned ]; then
    # The manifest is the last artifact removed; a crash before this point is retryable.
    [ ! -L "$manifest_path" ] || die 'manifest must not be symlink'
    rm -f "$manifest_path" || die 'manifest cleanup failed'
  fi
  printf 'router release finalized\n'
}
status() {
  state_path "$manifest_path" || die 'manifest path outside state directory'
  [ ! -L "$manifest_path" ] || die 'manifest must not be symlink'
  if [ ! -e "$manifest_path" ]; then printf 'state=none\n'; return 0; fi
  [ -f "$manifest_path" ] || die 'manifest must be regular file'
  [ "$(stat -c '%a' "$manifest_path" 2>/dev/null || printf 0)" = 600 ] || die 'manifest must be mode 600'
  cat "$manifest_path"
}
usage() { printf '%s\n' 'usage: router-release.sh prepare|cutover|rollback|finalize|watchdog|status'; }

command=${1:-}
case "$command" in
  prepare) [ "$#" -eq 1 ] || die "$(usage)"; prepare;;
  cutover) [ "$#" -eq 1 ] || die "$(usage)"; cutover;;
  rollback) [ "$#" -eq 1 ] || die "$(usage)"; rollback;;
  finalize) [ "$#" -eq 1 ] || die "$(usage)"; finalize;;
  watchdog) [ "$#" -eq 1 ] || die "$(usage)"; watchdog;;
  status) [ "$#" -eq 1 ] || die "$(usage)"; status;;
  *) usage >&2; exit 2;;
esac
