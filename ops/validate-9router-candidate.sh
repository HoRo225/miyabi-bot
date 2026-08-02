#!/bin/sh
set -eu
umask 077

FIXED_DIGEST=sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9
FIXED_REVISION=6fcd27337a7893642c7fe630840d0a641743f28f
FIXED_PLATFORM=linux/amd64
FIXED_IMAGE=decolua/9router@$FIXED_DIGEST
die() { printf '9R-CANDIDATE-%s\n' "$1" >&2; exit "$2"; }
expected_digest_override=$(printenv CANDIDATE_EXPECTED_DIGEST 2>/dev/null || true)
expected_revision_override=$(printenv CANDIDATE_EXPECTED_REVISION 2>/dev/null || true)
expected_platform_override=$(printenv CANDIDATE_EXPECTED_PLATFORM 2>/dev/null || true)
test_mode=${CANDIDATE_TEST_MODE:-0}
case "$test_mode" in
  ''|0) test_mode=0;;
  1) [ "${PRODUCTION_VALIDATION:-}" != 1 ] || die TEST-MODE-001 2;;
  *) die TEST-MODE-001 2;;
esac
[ -z "$expected_digest_override" ] || [ "$expected_digest_override" = "$FIXED_DIGEST" ] || die EXPECTATION-001 2
[ -z "$expected_revision_override" ] || [ "$expected_revision_override" = "$FIXED_REVISION" ] || die EXPECTATION-001 2
[ -z "$expected_platform_override" ] || [ "$expected_platform_override" = "$FIXED_PLATFORM" ] || die EXPECTATION-001 2
EXPECTED_DIGEST=$FIXED_DIGEST
EXPECTED_REVISION=$FIXED_REVISION
EXPECTED_PLATFORM=$FIXED_PLATFORM
CANDIDATE_URL=$(printenv CANDIDATE_URL 2>/dev/null || true)
CANDIDATE_CONTAINER=$(printenv CANDIDATE_CONTAINER 2>/dev/null || true)
CANDIDATE_IMAGE=$(printenv CANDIDATE_IMAGE 2>/dev/null || true)
CANDIDATE_VOLUME=$(printenv CANDIDATE_VOLUME 2>/dev/null || true)
CANDIDATE_MANIFEST_FILE=$(printenv CANDIDATE_MANIFEST_FILE 2>/dev/null || true)
CANDIDATE_PASSWORD_FILE=$(printenv CANDIDATE_PASSWORD_FILE 2>/dev/null || true)
CANDIDATE_PASSWORD_FD=$(printenv CANDIDATE_PASSWORD_FD 2>/dev/null || true)
CANDIDATE_API_KEY_FILE=$(printenv CANDIDATE_API_KEY_FILE 2>/dev/null || true)
CANDIDATE_GEMINI_KEY_FILE=$(printenv CANDIDATE_GEMINI_KEY_FILE 2>/dev/null || true)
CANDIDATE_GEMINI_KEY_FD=$(printenv CANDIDATE_GEMINI_KEY_FD 2>/dev/null || true)
CANDIDATE_API_KEY_FD=$(printenv CANDIDATE_API_KEY_FD 2>/dev/null || true)
CANDIDATE_CLIENT_KEY_ID_FILE=$(printenv CANDIDATE_CLIENT_KEY_ID_FILE 2>/dev/null || true)
CANDIDATE_MARKER=$(printenv CANDIDATE_MARKER 2>/dev/null || true)
[ -n "$CANDIDATE_MARKER" ] || CANDIDATE_MARKER=9router-candidate-payload-zero
DOCKER_BIN=$(printenv CANDIDATE_DOCKER_BIN 2>/dev/null || true)
[ -n "$DOCKER_BIN" ] || DOCKER_BIN=docker
CURL_BIN=$(printenv CANDIDATE_CURL_BIN 2>/dev/null || true)
[ -n "$CURL_BIN" ] || CURL_BIN=curl
TMP_DIR=$(mktemp -d)
chmod 700 "$TMP_DIR"
auth_cfg=; trap 'unset password gemini_key api_key; rm -f "${auth_cfg:-}"; rm -rf "$TMP_DIR"' EXIT HUP INT TERM

need() { [ -n "$2" ] || die "$3" "$4"; }
secure_file() {
  [ -n "$1" ] && [ ! -L "$1" ] && [ -f "$1" ] || return 1
  [ "$(stat -c '%a' "$1" 2>/dev/null || printf 0)" = 600 ]
}
read_secret() {
  if [ -n "$1" ]; then secure_file "$1" || return 1; cat "$1"; return; fi
  if [ -n "$2" ]; then case "$2" in *[!0-9]*) return 1;; esac; eval "cat <&$2"; return; fi
  return 1
}

need URL "$CANDIDATE_URL" URL-001 10
need CONTAINER "$CANDIDATE_CONTAINER" CONTAINER-001 11
need IMAGE "$CANDIDATE_IMAGE" IMAGE-001 12
need GEMINI_KEY "$CANDIDATE_GEMINI_KEY_FILE$CANDIDATE_GEMINI_KEY_FD" SECRET-004 15
need VOLUME "$CANDIDATE_VOLUME" VOLUME-001 13
need CLIENT_KEY_ID "$CANDIDATE_CLIENT_KEY_ID_FILE" CLIENT-001 14
[ "$CANDIDATE_IMAGE" = "$FIXED_IMAGE" ] || die IMAGE-002 16
case "$CANDIDATE_MARKER" in *[!A-Za-z0-9._-]*) die MARKER-001 17;; esac
case "$CANDIDATE_URL" in http://127.0.0.1:[0-9]*) ;; *) die LOOPBACK-001 18;; esac
candidate_port=$(printf '%s' "$CANDIDATE_URL" | sed -n 's#^http://[^:]*:\([0-9][0-9]*\)$#\1#p')
case "$candidate_port" in ''|*[!0-9]*) die LOOPBACK-001 18;; esac
if [ "$candidate_port" = 20128 ]; then
  [ "$(printenv PRODUCTION_VALIDATION 2>/dev/null || true)" = 1 ] || die LOOPBACK-001 18
fi

container_image_id=$("$DOCKER_BIN" inspect --format '{{.Image}}' "$CANDIDATE_CONTAINER" 2>/dev/null || true)
[ -n "$container_image_id" ] || die PLATFORM-001 20
container_platform=$("$DOCKER_BIN" image inspect --format '{{.Os}}/{{.Architecture}}' "$container_image_id" 2>/dev/null || true)
[ "$container_platform" = "$EXPECTED_PLATFORM" ] || die PLATFORM-001 20
published=$("$DOCKER_BIN" port "$CANDIDATE_CONTAINER" 20128/tcp 2>/dev/null || true)
printf '%s\n' "$published" | grep -Eq "^127\\.0\\.0\\.1:$candidate_port\$" || die LOOPBACK-002 21
mount_name=$("$DOCKER_BIN" inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$CANDIDATE_CONTAINER" 2>/dev/null || true)
[ "$mount_name" = "$CANDIDATE_VOLUME" ] || die VOLUME-002 22
case "$CANDIDATE_VOLUME" in horo-discord-bot_9router-data) die VOLUME-003 23;; esac

image_ref=$("$DOCKER_BIN" inspect --format '{{.Config.Image}}' "$CANDIDATE_CONTAINER" 2>/dev/null || true)
[ "$image_ref" = "$CANDIDATE_IMAGE" ] || die IMAGE-003 24
repo_digests=$("$DOCKER_BIN" image inspect --format '{{json .RepoDigests}}' "$container_image_id" 2>/dev/null || true)
printf '%s' "$repo_digests" |
  jq -e --arg expected "$EXPECTED_DIGEST" '
    type == "array" and length > 0
    and all(.[]; type == "string" and test("^[^@[:space:]]+@sha256:[0-9a-f]{64}$"))
    and any(.[]; endswith("@" + $expected))
  ' >/dev/null 2>&1 || die DIGEST-001 30
manifest="$TMP_DIR/manifest.json"
if [ -n "$CANDIDATE_MANIFEST_FILE" ]; then secure_file "$CANDIDATE_MANIFEST_FILE" || die MANIFEST-001 31; cp "$CANDIDATE_MANIFEST_FILE" "$manifest"
else "$DOCKER_BIN" manifest inspect --verbose "decolua/9router@$EXPECTED_DIGEST" >"$manifest" 2>/dev/null || die MANIFEST-001 31
fi
jq -e --arg digest "$EXPECTED_DIGEST" '
  type == "object"
  and (.Descriptor | type == "object")
  and (.Descriptor.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.Descriptor.platform | type == "object")
  and (.Descriptor.platform.architecture | type == "string")
  and (.Descriptor.platform.os | type == "string")
  and (.Descriptor.digest == $digest)
  and (.Descriptor.platform.architecture == "amd64")
  and (.Descriptor.platform.os == "linux")
' "$manifest" >/dev/null 2>&1 || die DIGEST-002 32
revision=$("$DOCKER_BIN" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container_image_id" 2>/dev/null || true)
[ "$revision" = "$EXPECTED_REVISION" ] || die REVISION-001 33

client_id=$(read_secret "$CANDIDATE_CLIENT_KEY_ID_FILE" "" 2>/dev/null || true)
printf '%s' "$client_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || die CLIENT-002 40
password=$(read_secret "$CANDIDATE_PASSWORD_FILE" "$CANDIDATE_PASSWORD_FD" 2>/dev/null || true)
[ -n "$password" ] || die SECRET-001 41
printf '%s' "$password" | awk 'length($0)>=16 {ok=1} END{exit(ok?0:1)}' || die SECRET-001 41
case "$password" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~!@%+=,-]*) die SECRET-002 42;; esac
gemini_key=$(read_secret "$CANDIDATE_GEMINI_KEY_FILE" "$CANDIDATE_GEMINI_KEY_FD" 2>/dev/null || true)
[ -n "$gemini_key" ] || die SECRET-004 43
case "$gemini_key" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-]*) die SECRET-005 44;; esac
printf '{"password":"%s"}\n' "$password" >"$TMP_DIR/password.json"
cookie="$TMP_DIR/cookie.jar"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/status.json" --write-out '%{http_code}' --max-time 15 "$CANDIDATE_URL/api/auth/status" 2>/dev/null || true)
[ "$code" = 200 ] || die DASHBOARD-001 50
grep -Eq '"requireLogin"[[:space:]]*:[[:space:]]*true' "$TMP_DIR/status.json" || die DASHBOARD-002 51
code=$("$CURL_BIN" --silent --output "$TMP_DIR/login.json" --write-out '%{http_code}' --max-time 15 -c "$cookie" -H 'Content-Type: application/json' --data-binary "@$TMP_DIR/password.json" "$CANDIDATE_URL/api/auth/login" 2>/dev/null || true)
[ "$code" = 200 ] || die DASHBOARD-003 52

keys_file="$TMP_DIR/keys.json"
code=$("$CURL_BIN" --silent --output "$keys_file" --write-out '%{http_code}' --max-time 15 -b "$cookie" "$CANDIDATE_URL/api/keys" 2>/dev/null || true)
[ "$code" = 200 ] || die CLIENT-003 43
grep -Eq '"id"[[:space:]]*:[[:space:]]*"'"$client_id"'"' "$keys_file" || die CLIENT-004 44

printf '{"enableObservability2":false}\n' >"$TMP_DIR/observability.json"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/observability-patch.json" --write-out '%{http_code}' --max-time 15 -b "$cookie" -c "$cookie" -H 'Content-Type: application/json' -X PATCH --data-binary "@$TMP_DIR/observability.json" "$CANDIDATE_URL/api/settings" 2>/dev/null || true)
[ "$code" = 200 ] || die OBSERVABILITY-001 60
code=$("$CURL_BIN" --silent --output "$TMP_DIR/settings.json" --write-out '%{http_code}' --max-time 15 -b "$cookie" "$CANDIDATE_URL/api/settings" 2>/dev/null || true)
[ "$code" = 200 ] || die OBSERVABILITY-002 61
grep -Eq '"enableObservability2"[[:space:]]*:[[:space:]]*false' "$TMP_DIR/settings.json" || die OBSERVABILITY-003 62

api_key=$(read_secret "$CANDIDATE_API_KEY_FILE" "$CANDIDATE_API_KEY_FD" 2>/dev/null || true)
printf '%s' "$api_key" | grep -Eq '^sk-[a-z0-9-]{8,}$' || die SECRET-003 45
auth_cfg="$TMP_DIR/curl-auth.conf"; printf 'header = "Authorization: Bearer %s"\n' "$api_key" >"$auth_cfg"
chmod 600 "$auth_cfg"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/unauth.json" --write-out '%{http_code}' --max-time 15 "$CANDIDATE_URL/v1/models" 2>/dev/null || true)
[ "$code" = 401 ] || die MODELS-001 70
code=$("$CURL_BIN" --silent --config "$auth_cfg" --output "$TMP_DIR/models.json" --write-out '%{http_code}' --max-time 15 "$CANDIDATE_URL/v1/models" 2>/dev/null || true)
[ "$code" = 200 ] || die MODELS-002 71
grep -Fq '"gemini/gemini-3.6-flash"' "$TMP_DIR/models.json" || die MODELS-003 72

usage_value() { sed -n 's/.*"totalRequests"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p; s/.*"requests"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" | head -n 1; }
code=$("$CURL_BIN" --silent --output "$TMP_DIR/usage-before.json" --write-out '%{http_code}' --max-time 15 -b "$cookie" "$CANDIDATE_URL/api/usage/stats?period=all" 2>/dev/null || true)
[ "$code" = 200 ] || die USAGE-001 80
usage_before=$(usage_value "$TMP_DIR/usage-before.json")
case "$usage_before" in ''|*[!0-9]*) die USAGE-003 82;; esac
printf '{"model":"gemini/gemini-3.6-flash","messages":[{"role":"user","content":"candidate canary %s"}],"stream":false}\n' "$CANDIDATE_MARKER" >"$TMP_DIR/canary.json"
code=$("$CURL_BIN" --silent --config "$auth_cfg" --output "$TMP_DIR/canary-response.json" --write-out '%{http_code}' --max-time 30 -H 'Content-Type: application/json' --data-binary "@$TMP_DIR/canary.json" "$CANDIDATE_URL/v1/chat/completions" 2>/dev/null || true)
[ "$code" = 200 ] || die CANARY-001 90
USAGE_POLL_ATTEMPTS=$(printenv CANDIDATE_USAGE_POLL_ATTEMPTS 2>/dev/null || true)
[ -n "$USAGE_POLL_ATTEMPTS" ] || USAGE_POLL_ATTEMPTS=30
grep -Eq '"choices"[[:space:]]*:' "$TMP_DIR/canary-response.json" || die CANARY-002 91
usage_after=
i=0
case "$USAGE_POLL_ATTEMPTS" in ''|*[!0-9]*|??????*) die USAGE-004 83 ;; esac
[ "$USAGE_POLL_ATTEMPTS" -ge 1 ] 2>/dev/null || die USAGE-004 83
[ "$USAGE_POLL_ATTEMPTS" -le 300 ] 2>/dev/null || die USAGE-004 83
while [ "$i" -lt "$USAGE_POLL_ATTEMPTS" ]; do
  "$CURL_BIN" --silent --output "$TMP_DIR/usage-after.json" --max-time 15 -b "$cookie" "$CANDIDATE_URL/api/usage/stats?period=all" 2>/dev/null || true
  usage_after=$(usage_value "$TMP_DIR/usage-after.json")
  case "$usage_after" in ''|*[!0-9]*) ;; *) [ "$usage_after" -gt "$usage_before" ] && break;; esac
  i=$((i + 1)); sleep 1
done
case "$usage_after" in ''|*[!0-9]*) die USAGE-003 82;; esac
[ "$usage_after" -gt "$usage_before" ] || die USAGE-002 81
pattern_file() {
  source=$1
  value=$2
  name=$3
  if [ -n "$source" ]; then
    secure_file "$source" || return 1
    printf '%s' "$source"
    return 0
  fi
  target="$TMP_DIR/$name.pattern"
  printf '%s\n' "$value" >"$target" || return 1
  chmod 600 "$target" || return 1
  printf '%s' "$target"
}
password_pattern=$(pattern_file "$CANDIDATE_PASSWORD_FILE" "$password" password) || die SECRET-LOG-002 106
gemini_pattern=$(pattern_file "$CANDIDATE_GEMINI_KEY_FILE" "$gemini_key" gemini) || die SECRET-LOG-002 106
api_pattern=$(pattern_file "$CANDIDATE_API_KEY_FILE" "$api_key" api) || die SECRET-LOG-002 106
secret_log_scan() {
  file=$1
  for pattern in "$password_pattern" "$gemini_pattern" "$api_pattern"; do
    [ -r "$pattern" ] || die SECRET-LOG-002 106
    if grep -Fq -f "$pattern" -- "$file" 2>/dev/null; then die SECRET-LOG-001 107; fi
  done
}

for endpoint in /api/usage/request-details /api/usage/logs; do
  code=$("$CURL_BIN" --silent --output "$TMP_DIR/endpoint.json" --write-out '%{http_code}' --max-time 15 -b "$cookie" "$CANDIDATE_URL$endpoint" 2>/dev/null || true)
  secret_log_scan "$TMP_DIR/endpoint.json"
  [ "$code" = 200 ] || die MARKER-002 101
  grep -Fq "$CANDIDATE_MARKER" "$TMP_DIR/endpoint.json" && die MARKER-003 102
done
if "$DOCKER_BIN" exec "$CANDIDATE_CONTAINER" sh -c "grep -R -F -- '$CANDIDATE_MARKER' /app/data 2>/dev/null" >"$TMP_DIR/volume-marker" 2>/dev/null; then
  die MARKER-004 103
else
  rc=$?
  [ "$rc" = 1 ] || die MARKER-006 105
fi
"$DOCKER_BIN" logs "$CANDIDATE_CONTAINER" >"$TMP_DIR/container-log" 2>/dev/null || die MARKER-007 106
secret_log_scan "$TMP_DIR/container-log"
grep -Fq "$CANDIDATE_MARKER" "$TMP_DIR/container-log" && die MARKER-005 104
printf '9R-CANDIDATE-OK\n'
