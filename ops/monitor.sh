#!/bin/sh
set -eu

# cron: */5 * * * * /bin/sh /srv/horo-discord-bot/ops/monitor.sh
PROJECT_DIR=${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
ENV_FILE=${MONITOR_ENV_FILE:-/srv/horo-discord-bot-monitor.env}
STATE_FILE=${MONITOR_STATE_FILE:-/tmp/horo-discord-bot-monitor.last}

if [ -f "$ENV_FILE" ]; then
  # The mode-600 file is outside the repository and contains DISCORD_MONITOR_WEBHOOK_URL.
  . "$ENV_FILE"
fi

cd "$PROJECT_DIR"
problems=""

for service in 9router searxng bot-prod; do
  cid=$(docker compose ps -q "$service")
  if [ -z "$cid" ]; then
    problems="${problems}${service}: missing; "
    continue
  fi
  state=$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' "$cid")
  status=${state%%|*}
  rest=${state#*|}
  health=${rest%%|*}
  restarts=${rest##*|}
  if [ "$status" != running ] || [ "$health" != healthy ] || [ "$restarts" -gt 0 ]; then
    problems="${problems}${service}: ${status}/${health}, restarts=${restarts}; "
  fi
done

router_cid=$(docker compose ps -q 9router)
if [ -n "$router_cid" ]; then
  if docker top "$router_cid" 2>/dev/null | grep -Fq cloudflared; then
    problems="${problems}9router: cloudflared is running; "
  fi
  binding=$(docker port "$router_cid" 20128/tcp 2>/dev/null || true)
  case "$binding" in
    127.0.0.1:20128)
      ;;
    192.168.1.107:20128)
      code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
        http://192.168.1.107:20128/v1/models || true)
      if [ "$code" != 401 ]; then
        problems="${problems}9router: unauthenticated LAN API returned ${code:-000}; "
      fi
      auth_status=$(curl --silent --fail --max-time 5 \
        http://192.168.1.107:20128/api/auth/status || true)
      if ! printf '%s' "$auth_status" | grep -Eq '"requireLogin"[[:space:]]*:[[:space:]]*true' ||
        ! printf '%s' "$auth_status" | grep -Eq '"hasPassword"[[:space:]]*:[[:space:]]*true'; then
        problems="${problems}9router: dashboard login protection is disabled; "
      fi
      ;;
    *)
      problems="${problems}9router: unexpected port binding ${binding:-none}; "
      ;;
  esac
fi

bot_cid=$(docker compose ps -q bot-prod)
if [ -n "$bot_cid" ]; then
  if alerts=$(docker exec "$bot_cid" node -e \
    "const fs=require('node:fs');const h=JSON.parse(fs.readFileSync('/tmp/horo-bot-health.json','utf8'));const a=Array.isArray(h.alerts)?h.alerts:[];process.stdout.write(a.filter(x=>x&&x.code==='slash_command_registration_failed'&&/^\\d+$/.test(x.guildId)).map(x=>x.code+':'+x.guildId).join(','))" 2>/dev/null); then
    if [ -n "$alerts" ]; then
      problems="${problems}bot-prod: ${alerts}; "
    fi
  else
    problems="${problems}bot-prod: health alerts unreadable; "
  fi
fi

previous=$(cat "$STATE_FILE" 2>/dev/null || true)
if [ -z "$problems" ]; then
  rm -f "$STATE_FILE"
  exit 0
fi
if [ "$problems" = "$previous" ]; then
  exit 0
fi

if [ -z "${DISCORD_MONITOR_WEBHOOK_URL:-}" ]; then
  printf '%s\n' "$problems" >&2
  exit 1
fi

safe=$(printf '%s' "$problems" | sed 's/["\\]/_/g')
payload=$(printf '{"content":"Miyabi monitor: %s"}' "$safe")
curl --fail --silent --show-error --max-time 10 \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" --config - <<EOF
url = "$DISCORD_MONITOR_WEBHOOK_URL"
EOF
printf '%s' "$problems" > "$STATE_FILE"
