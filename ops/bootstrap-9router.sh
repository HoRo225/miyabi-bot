#!/bin/sh
set -eu

PROJECT_DIR=${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
LOOPBACK=127.0.0.1
MODE=${1:-start}
# `start` is a manual dashboard initialization helper; release/cutover is owned by ops/router-release.sh.
OPS_LOCK_FILE=${OPS_LOCK_FILE:-/tmp/horo-discord-bot-ops.lock}
SYNCED_KEY_CHANGED=0
cd "$PROJECT_DIR"

if [ "${MIYABI_OPS_LOCK_HELD:-0}" != 1 ]; then
  exec 9>"$OPS_LOCK_FILE"
  if [ "$MODE" = sync-key ]; then flock -n 9 || exit 0; else flock 9; fi
fi

fixed_error() { printf '9R-BOOTSTRAP-%s\n' "$1" >&2; }
binding() { cid=$(docker compose ps -q 9router); [ -n "$cid" ] && docker port "$cid" 20128/tcp 2>/dev/null || true; }
cloudflared_running() { cid=$(docker compose ps -q 9router); [ -n "$cid" ] && docker top "$cid" 2>/dev/null | grep -Fq cloudflared; }
api_is_protected() { code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://$1:20128/v1/models" 2>/dev/null || true); [ "$code" = 401 ]; }
dashboard_is_protected() {
  f=$(mktemp); curl --silent --fail --max-time 5 "http://$1:20128/api/auth/status" >"$f" 2>/dev/null || { rm -f "$f"; return 1; }
  grep -Eq '"requireLogin"[[:space:]]*:[[:space:]]*true' "$f"; rc=$?; rm -f "$f"; return "$rc"
}
security_is_ready() { api_is_protected "$LOOPBACK" && dashboard_is_protected "$LOOPBACK" && ! cloudflared_running; }
remove_legacy_bind() {
  [ -f .env ] && [ ! -L .env ] || { fixed_error ENV-001; return 1; }
  if ! grep -Eq '^(NINE_ROUTER_INITIAL_PASSWORD|NINE_ROUTER_BOOTSTRAP_PASSWORD|NINE_ROUTER_BIND_ADDRESS)=' .env; then return 0; fi; f=$(mktemp .env.bootstrap.XXXXXX)
  if ! awk '/^NINE_ROUTER_INITIAL_PASSWORD=/ { next } /^NINE_ROUTER_BOOTSTRAP_PASSWORD=/ { next } /^NINE_ROUTER_BIND_ADDRESS=/ { next } { print }' .env >"$f"; then rm -f "$f"; fixed_error ENV-001; return 1; fi
  chmod 600 "$f" && mv "$f" .env || { rm -f "$f"; fixed_error ENV-001; return 1; }
}
set_env_secret() {
  name=$1; value=$2; [ -f .env ] || { fixed_error ENV-001; return 1; }; f=$(mktemp .env.secret.XXXXXX)
  if ! { printf '%s\n' "$value"; cat .env; } | awk -v name="$name" 'NR == 1 { value = $0; next } index($0, name "=") == 1 { if (!written) print name "=" value; written=1; next } { print } END { if (!written) print name "=" value }' >"$f"; then rm -f "$f"; fixed_error ENV-001; return 1; fi
  chmod 600 "$f" && mv "$f" .env || { rm -f "$f"; fixed_error ENV-001; return 1; }
}
write_key_metadata() {
  keys_json=$1; applied_id=$2; mkdir -p data; f=$(mktemp data/9router-api-keys.json.XXXXXX)
  [ -n "$applied_id" ] && applied_json="\"$applied_id\"" || applied_json=null
  printf '{"updatedAt":"%s","appliedId":%s,"keys":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$applied_json" "$keys_json" >"$f" || { rm -f "$f"; fixed_error KEY-SYNC-001; return 1; }
  chmod 600 "$f" && mv "$f" data/9router-api-keys.json || { rm -f "$f"; fixed_error KEY-SYNC-001; return 1; }
}
STATUS_DIR=${STATUS_DIR:-data/status}
STATUS_PATH=${STATUS_PATH:-$STATUS_DIR/key-sync.json}
status_timestamp() { sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' "$STATUS_PATH" 2>/dev/null | head -n 1; }
write_module_status() {
  state=$1; error_code=${2:-}; case "$state" in ready|degraded) ;; *) fixed_error STATUS-001; return 1;; esac
  [ -n "$error_code" ] || error_code=KEY-SYNC-001
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ); prev_ok=$(status_timestamp lastSuccessAt || true); prev_err=$(status_timestamp lastErrorAt || true)
  if [ "$state" = ready ]; then success_json="\"$now\""; [ -n "$prev_err" ] && error_json="\"$prev_err\"" || error_json=null; code_json=null
  else [ -n "$prev_ok" ] && success_json="\"$prev_ok\"" || success_json=null; error_json="\"$now\""; code_json="\"$error_code\""; fi
  [ ! -L "$STATUS_DIR" ] || { fixed_error STATUS-001; return 1; }; mkdir -p "$STATUS_DIR" && chmod 700 "$STATUS_DIR" || { fixed_error STATUS-001; return 1; }
  f="$STATUS_PATH.$$"; [ ! -L "$STATUS_PATH" ] && [ ! -L "$f" ] || { fixed_error STATUS-001; return 1; }
  printf '{"module":"key-sync","state":"%s","lastSuccessAt":%s,"lastErrorAt":%s,"errorCode":%s}\n' "$state" "$success_json" "$error_json" "$code_json" >"$f" || { rm -f "$f"; fixed_error STATUS-001; return 1; }
  chmod 600 "$f" && mv "$f" "$STATUS_PATH" || { rm -f "$f"; fixed_error STATUS-001; return 1; }; chmod 600 "$STATUS_PATH"
}
ensure_observability_disabled() {
  docker compose exec -T 9router node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/app/data/db/data.sqlite");
    const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
    const value = row?.data ? JSON.parse(row.data) : {};
    value.enableObservability2 = false;
    db.prepare("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(value));
    const check = db.prepare("SELECT data FROM settings WHERE id = 1").get();
    db.close(); if (JSON.parse(check?.data || "{}").enableObservability2 !== false) process.exit(3);
  ' >/dev/null 2>&1 || { fixed_error OBS-001; return 1; }
}
sync_bot_api_key() {
  SYNCED_KEY_CHANGED=0
  keys_json=$(docker compose exec -T 9router node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true }); const rows = db.prepare("SELECT id, name, createdAt FROM apiKeys WHERE isActive = 1 ORDER BY createdAt DESC").all(); db.close(); process.stdout.write(JSON.stringify(rows));' 2>/dev/null) || { write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  selected_id=$(docker compose exec -T bot-prod node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/app/data/bot.sqlite", { readOnly: true }); const row = db.prepare("SELECT value FROM ai_runtime_settings WHERE key = ?").get("ai_9router_key_id"); db.close(); if (row?.value) process.stdout.write(row.value);' 2>/dev/null || true)
  if [ -n "$selected_id" ] && ! printf '%s' "$selected_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then write_key_metadata "$keys_json" ""; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; fi
  chosen_id=$(docker compose exec -T 9router node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true }); const requested = process.argv[1] || ""; const active = db.prepare("SELECT id FROM apiKeys WHERE isActive = 1 ORDER BY createdAt DESC").all(); const row = requested ? active.find((item) => item.id === requested) : active.length === 1 ? active[0] : null; db.close(); if (!row) process.exit(4); process.stdout.write(row.id);' "$selected_id" 2>/dev/null) || { write_key_metadata "$keys_json" ""; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  api_key=$(docker compose exec -T 9router node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true }); const row = db.prepare("SELECT key FROM apiKeys WHERE id = ? AND isActive = 1").get(process.argv[1]); db.close(); if (!row?.key) process.exit(3); process.stdout.write(row.key);' "$chosen_id" 2>/dev/null) || { write_key_metadata "$keys_json" ""; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  printf '%s' "$api_key" | grep -Eq '^sk-[a-z0-9-]{8,}$' || { api_key=; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  auth_cfg=$(mktemp) || { api_key=; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  printf 'header = "Authorization: Bearer %s"\n' "$api_key" >"$auth_cfg" && chmod 600 "$auth_cfg" || { rm -f "$auth_cfg"; auth_cfg=; api_key=; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  trap 'rm -f "${auth_cfg:-}"' HUP INT TERM; code=$(curl --silent --config "$auth_cfg" --output /dev/null --write-out '%{http_code}' --max-time 10 "http://$LOOPBACK:20128/v1/models" 2>/dev/null || true); rm -f "$auth_cfg"; auth_cfg=; trap - HUP INT TERM
  [ "$code" = 200 ] || { api_key=; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  write_key_metadata "$keys_json" "$chosen_id" || { api_key=; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  current_key=$(sed -n 's/^AI_API_KEY=//p' .env | tail -n 1) || { api_key=; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  if [ "$api_key" = "$current_key" ]; then api_key=; current_key=; write_module_status ready "" || return 1; return; fi
  current_key=; set_env_secret AI_API_KEY "$api_key" || { api_key=; write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; return 1; }
  api_key=; SYNCED_KEY_CHANGED=1; write_module_status ready "" || return 1
}
read_bootstrap_password() {
  if [ -n "${NINE_ROUTER_BOOTSTRAP_PASSWORD_FILE:-}" ]; then
    file=$NINE_ROUTER_BOOTSTRAP_PASSWORD_FILE
    [ ! -L "$file" ] && [ -f "$file" ] && [ "$(stat -c '%a' "$file" 2>/dev/null || printf 0)" = 600 ] || { fixed_error SECRET-001; return 1; }
    cat "$file"; return
  fi
  if [ ! -t 0 ]; then IFS= read -r password || true; printf '%s' "$password"; unset password; return; fi
  printf '一次性 9router 初始密碼（至少 16 字元）：'; stty -echo; trap 'stty echo 2>/dev/null || true' HUP INT TERM 0; IFS= read -r password; stty echo; trap - HUP INT TERM 0; printf '\n'; printf '%s' "$password"; unset password
}
fail_safe() { remove_legacy_bind || true; docker compose stop 9router >/dev/null 2>&1 || true; }

case "$MODE" in
  guard)
    remove_legacy_bind || exit 1
    if [ "$(binding)" != "$LOOPBACK:20128" ] || ! security_is_ready || ! ensure_observability_disabled; then fail_safe; fixed_error GUARD-001; exit 2; fi
    ;;
  start)
    remove_legacy_bind || exit 1
    existing_router_id=$(docker compose ps -aq 9router 2>/dev/null || true)
    if [ -n "$existing_router_id" ]; then
      existing_router_image=$(docker inspect --format '{{.Config.Image}}' "$existing_router_id" 2>/dev/null || true)
      [ "$existing_router_image" = "decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9" ] || { fixed_error IMAGE-001; exit 1; }
    fi
    docker compose stop 9router >/dev/null 2>&1 || true; password=$(read_bootstrap_password) || exit 2
    [ "${#password}" -ge 16 ] || { unset password; fixed_error SECRET-001; exit 2; }
    case "$password" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~!@%+=,-]*) unset password; fixed_error SECRET-001; exit 2;; esac
    umask 077; secret_file=$(mktemp /tmp/9router-bootstrap-env.XXXXXX); override_file=$(mktemp /tmp/9router-bootstrap-compose.XXXXXX)
    cleanup() { rm -f "$secret_file" "$override_file"; unset password; }; trap cleanup HUP INT TERM 0
    printf 'INITIAL_PASSWORD=%s\n' "$password" >"$secret_file"; chmod 600 "$secret_file"; printf 'services:\n  9router:\n    env_file:\n      - %s\n' "$secret_file" >"$override_file"; chmod 600 "$override_file"
    docker compose -f docker-compose.yml -f "$override_file" up -d --force-recreate --wait --wait-timeout 180 9router >/dev/null 2>&1 || { fixed_error START-001; exit 1; }
    [ "$(binding)" = "$LOOPBACK:20128" ] || { fixed_error BIND-001; exit 1; }; ensure_observability_disabled || exit 1; cleanup; trap - HUP INT TERM 0
    printf '%s\n' '9router 已限制在 server loopback。Dashboard 僅可經 Tailscale SSH tunnel：' 'ssh -N -L 20128:127.0.0.1:20128 horo@100.117.174.2' '開啟 http://127.0.0.1:20128 後登入並完成 provider/client key 設定。' '完成後執行：sh ops/bootstrap-9router.sh finish'
    ;;
  finish)
    remove_legacy_bind || exit 1; [ "$(binding)" = "$LOOPBACK:20128" ] || { fixed_error BIND-001; exit 1; }; security_is_ready || { fixed_error SECURITY-001; exit 1; }; ensure_observability_disabled || exit 1; sync_bot_api_key || exit 1
    if [ "$SYNCED_KEY_CHANGED" = 1 ]; then docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 bot-prod >/dev/null 2>&1 || { fixed_error BOT-RESTART-001; exit 1; }; fi
    printf '9R-BOOTSTRAP-FINISH-OK\n'
    ;;
  sync-key)
    remove_legacy_bind || exit 1; [ "$(binding)" = "$LOOPBACK:20128" ] || { write_module_status degraded KEY-SYNC-001 || true; fixed_error KEY-SYNC-001; exit 1; }; sync_bot_api_key || exit 1
    if [ "$SYNCED_KEY_CHANGED" = 1 ]; then docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 bot-prod >/dev/null 2>&1 || { fixed_error BOT-RESTART-001; exit 1; }; printf '9R-BOOTSTRAP-BOT-RESTART-ONCE\n'; else printf '9R-BOOTSTRAP-BOT-RESTART-0\n'; fi
    ;;
  *) printf 'usage: %s {start|finish|guard|sync-key}\n' "$0" >&2; exit 2 ;;
esac