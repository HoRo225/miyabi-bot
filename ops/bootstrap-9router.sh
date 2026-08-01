#!/bin/sh
set -eu

PROJECT_DIR=${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
LOOPBACK=127.0.0.1
LAN_ADDRESS=192.168.1.107
MODE=${1:-start}
OPS_LOCK_FILE=${OPS_LOCK_FILE:-/tmp/horo-discord-bot-ops.lock}

cd "$PROJECT_DIR"

if [ "${MIYABI_OPS_LOCK_HELD:-0}" != 1 ]; then
  exec 9>"$OPS_LOCK_FILE"
  if [ "$MODE" = sync-key ]; then
    flock -n 9 || exit 0
  else
    flock 9
  fi
fi

binding() {
  cid=$(docker compose ps -q 9router)
  [ -n "$cid" ] && docker port "$cid" 20128/tcp 2>/dev/null || true
}

cloudflared_running() {
  cid=$(docker compose ps -q 9router)
  [ -n "$cid" ] && docker top "$cid" 2>/dev/null | grep -Fq cloudflared
}

api_is_protected() {
  code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
    "http://$1:20128/v1/models" || true)
  [ "$code" = 401 ]
}

dashboard_is_protected() {
  status=$(curl --silent --fail --max-time 5 "http://$1:20128/api/auth/status" || true)
  printf '%s' "$status" | grep -Eq '"requireLogin"[[:space:]]*:[[:space:]]*true' &&
    printf '%s' "$status" | grep -Eq '"hasPassword"[[:space:]]*:[[:space:]]*true'
}

security_is_ready() {
  api_is_protected "$1" && dashboard_is_protected "$1" && ! cloudflared_running
}

set_persistent_bind() {
  [ -f .env ] || {
    printf '.env is required.\n' >&2
    exit 1
  }
  tmp=.env.bootstrap.$$
  umask 077
  if ! awk -v bind="$1" '
    BEGIN { written = 0 }
    /^NINE_ROUTER_INITIAL_PASSWORD=/ { next }
    /^NINE_ROUTER_BOOTSTRAP_PASSWORD=/ { next }
    /^NINE_ROUTER_BIND_ADDRESS=/ {
      if (!written) print "NINE_ROUTER_BIND_ADDRESS=" bind
      written = 1
      next
    }
    { print }
    END { if (!written) print "NINE_ROUTER_BIND_ADDRESS=" bind }
  ' .env > "$tmp"; then
    rm -f "$tmp"
    exit 1
  fi
  chmod 600 "$tmp"
  mv "$tmp" .env
}

set_env_secret() {
  name=$1
  value=$2
  [ -f .env ] || {
    printf '.env is required.\n' >&2
    exit 1
  }
  tmp=.env.secret.$$
  umask 077
  if ! { printf '%s\n' "$value"; cat .env; } | awk -v name="$name" '
    NR == 1 { value = $0; next }
    index($0, name "=") == 1 {
      if (!written) print name "=" value
      written = 1
      next
    }
    { print }
    END { if (!written) print name "=" value }
  ' > "$tmp"; then
    rm -f "$tmp"
    exit 1
  fi
  chmod 600 "$tmp"
  mv "$tmp" .env
}

write_key_metadata() {
  keys_json=$1
  applied_id=$2
  tmp=data/9router-api-keys.json.$$
  umask 077
  if [ -n "$applied_id" ]; then
    applied_json="\"$applied_id\""
  else
    applied_json=null
  fi
  printf '{"updatedAt":"%s","appliedId":%s,"keys":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$applied_json" "$keys_json" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" data/9router-api-keys.json
}

sync_bot_api_key() {
  SYNCED_KEY_CHANGED=0
  api_host=$1
  keys_json=$(docker compose exec -T 9router node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true });
    const rows = db.prepare("SELECT id, name, createdAt FROM apiKeys WHERE isActive = 1 ORDER BY createdAt DESC").all();
    db.close();
    process.stdout.write(JSON.stringify(rows));
  ') || {
    printf '無法讀取 9router key metadata。\n' >&2
    exit 1
  }
  selected_id=$(docker compose exec -T bot-prod node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/app/data/bot.sqlite", { readOnly: true });
    const row = db.prepare("SELECT value FROM ai_runtime_settings WHERE key = ?").get("ai_9router_key_id");
    db.close();
    if (row?.value) process.stdout.write(row.value);
  ' 2>/dev/null || true)
  if [ -n "$selected_id" ] && ! printf '%s' "$selected_id" | grep -Eq '^[0-9a-fA-F-]{36}$'; then
    write_key_metadata "$keys_json" ""
    printf 'Discord AI 設定中的 9router key ID 格式無效。\n' >&2
    exit 1
  fi
  chosen_id=$(docker compose exec -T 9router node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true });
    const requested = process.argv[1] || "";
    const active = db.prepare("SELECT id FROM apiKeys WHERE isActive = 1 ORDER BY createdAt DESC").all();
    const row = requested ? active.find((item) => item.id === requested) : active.length === 1 ? active[0] : null;
    db.close();
    if (!row) process.exit(4);
    process.stdout.write(row.id);
  ' "$selected_id") || {
    write_key_metadata "$keys_json" ""
    printf '請先在 Discord /ai-settings 選擇一個 active 9router key。\n' >&2
    exit 1
  }
  api_key=$(docker compose exec -T 9router node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true });
    const row = db.prepare("SELECT key FROM apiKeys WHERE id = ? AND isActive = 1").get(process.argv[1]);
    db.close();
    if (!row?.key) process.exit(3);
    process.stdout.write(row.key);
  ' "$chosen_id") || {
    write_key_metadata "$keys_json" ""
    printf '選擇的 9router key 已不存在或停用。\n' >&2
    exit 1
  }
  if ! printf '%s' "$api_key" | grep -Eq '^sk-[a-z0-9-]{8,}$'; then
    api_key=
    printf '9router key 格式驗證失敗。\n' >&2
    exit 1
  fi
  code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $api_key" "http://$api_host:20128/v1/models" || true)
  [ "$code" = 200 ] || {
    api_key=
    printf '9router key 無法通過 /v1/models 驗證。\n' >&2
    exit 1
  }
  write_key_metadata "$keys_json" "$chosen_id"
  keys_json=
  selected_id=
  chosen_id=
  current_key=$(sed -n 's/^AI_API_KEY=//p' .env | tail -n 1)
  if [ "$api_key" = "$current_key" ]; then
    api_key=
    current_key=
    return 0
  fi
  current_key=
  set_env_secret AI_API_KEY "$api_key"
  api_key=
  SYNCED_KEY_CHANGED=1
  printf '已自動同步 Discord 選擇的 9router client key 至 bot .env。\n'
}

configured_bind() {
  awk -F= '/^NINE_ROUTER_BIND_ADDRESS=/ { value = $2 } END { print value }' .env 2>/dev/null || true
}

fail_safe() {
  set_persistent_bind "$LOOPBACK"
  NINE_ROUTER_BIND_ADDRESS=$LOOPBACK docker compose up -d --force-recreate \
    --wait --wait-timeout 180 9router >/dev/null 2>&1 || true
}

case "$MODE" in
  guard)
    desired=$(configured_bind)
    case "$desired" in
      "")
        desired=$LOOPBACK
        ;;
      $LOOPBACK|$LAN_ADDRESS)
        ;;
      *)
        fail_safe
        printf '不安全的 9router bind 已隔離回 127.0.0.1。\n' >&2
        exit 2
        ;;
    esac
    if [ "$(binding)" = "$desired:20128" ] && security_is_ready "$desired"; then
      exit 0
    fi
    fail_safe
    printf '%s\n' \
      '9router 尚未完成安全初始化；服務已保持在 127.0.0.1。' \
      '請先執行：sh ops/bootstrap-9router.sh start'
    exit 2
    ;;

  start)
    set_persistent_bind "$LOOPBACK"
    docker compose stop 9router >/dev/null 2>&1 || true
    password=${NINE_ROUTER_BOOTSTRAP_PASSWORD:-}
    if [ -z "$password" ]; then
      [ -t 0 ] || {
        printf '請透過互動式終端執行，或暫時匯出 NINE_ROUTER_BOOTSTRAP_PASSWORD。\n' >&2
        exit 2
      }
      printf '一次性 9router 初始密碼（至少 16 字元）：' >&2
      stty -echo
      trap 'stty echo 2>/dev/null || true' HUP INT TERM 0
      IFS= read -r password
      stty echo
      trap - HUP INT TERM 0
      printf '\n' >&2
    fi
    [ "${#password}" -ge 16 ] || {
      printf '初始密碼至少需要 16 字元。\n' >&2
      exit 2
    }
    case "$password" in
      *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~!@%+=,-]*)
        printf '初始密碼只接受英數與 ._~!@%%+=,-。\n' >&2
        exit 2
        ;;
    esac

    umask 077
    secret_file=$(mktemp /tmp/9router-bootstrap-env.XXXXXX)
    override_file=$(mktemp /tmp/9router-bootstrap-compose.XXXXXX)
    cleanup() {
      rm -f "$secret_file" "$override_file"
      password=
    }
    trap cleanup HUP INT TERM 0
    printf 'INITIAL_PASSWORD=%s\n' "$password" > "$secret_file"
    printf 'services:\n  9router:\n    env_file:\n      - %s\n' "$secret_file" > "$override_file"
    NINE_ROUTER_BIND_ADDRESS=$LOOPBACK docker compose \
      -f docker-compose.yml -f "$override_file" up -d --force-recreate \
      --wait --wait-timeout 180 9router
    [ "$(binding)" = "$LOOPBACK:20128" ] || exit 1
    cleanup
    trap - HUP INT TERM 0

    printf '%s\n' \
      '9router 僅在 server loopback 啟動。接著：' \
      '1. 從工作站建立 SSH tunnel：ssh -N -L 20128:127.0.0.1:20128 horo@192.168.1.107' \
      '2. 開啟 http://127.0.0.1:20128，登入後立即更換 Dashboard 密碼。' \
      '3. 連接 provider、建立 client key、開啟 Require API key、關閉 Tunnel。' \
      '4. 執行：sh ops/bootstrap-9router.sh finish'
    ;;

  finish)
    [ "$(binding)" = "$LOOPBACK:20128" ] || {
      printf '拒絕完成：9router 目前不是 loopback-only。\n' >&2
      exit 1
    }
    security_is_ready "$LOOPBACK" || {
      printf '拒絕開放 LAN：API key、Dashboard 密碼與 tunnel 安全檢查尚未通過。\n' >&2
      exit 1
    }
    sync_bot_api_key "$LOOPBACK"

    set_persistent_bind "$LAN_ADDRESS"
    if ! NINE_ROUTER_BIND_ADDRESS=$LAN_ADDRESS docker compose up -d --force-recreate \
      --wait --wait-timeout 180 9router; then
      fail_safe
      exit 1
    fi
    if [ "$(binding)" != "$LAN_ADDRESS:20128" ] || ! security_is_ready "$LAN_ADDRESS"; then
      fail_safe
      printf 'LAN 驗證失敗；9router 已退回 127.0.0.1。\n' >&2
      exit 1
    fi
    docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 bot-prod
    printf '9router 已驗證 API key 保護並綁定 %s:20128。\n' "$LAN_ADDRESS"
    ;;

  sync-key)
    case "$(binding)" in
      $LOOPBACK:20128)
        api_host=$LOOPBACK
        ;;
      $LAN_ADDRESS:20128)
        api_host=$LAN_ADDRESS
        ;;
      *)
        printf '無法同步：9router binding 不符合安全設定。\n' >&2
        exit 1
        ;;
    esac
    sync_bot_api_key "$api_host"
    if [ "$SYNCED_KEY_CHANGED" = 1 ]; then
      docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 bot-prod
    fi
    ;;

  *)
    printf 'usage: %s {start|finish|guard|sync-key}\n' "$0" >&2
    exit 2
    ;;
esac
