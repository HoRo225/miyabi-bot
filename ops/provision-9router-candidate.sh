#!/bin/sh
set -eu
umask 077

CANDIDATE_URL=$(printenv CANDIDATE_URL 2>/dev/null || true)
PASSWORD_FILE=$(printenv CANDIDATE_PASSWORD_FILE 2>/dev/null || true)
PASSWORD_FD=$(printenv CANDIDATE_PASSWORD_FD 2>/dev/null || true)
GEMINI_KEY_FILE=$(printenv CANDIDATE_GEMINI_KEY_FILE 2>/dev/null || true)
GEMINI_KEY_FD=$(printenv CANDIDATE_GEMINI_KEY_FD 2>/dev/null || true)
CLIENT_KEY_FILE=$(printenv CANDIDATE_API_KEY_FILE 2>/dev/null || true)
CLIENT_ID_FILE=$(printenv CANDIDATE_CLIENT_KEY_ID_FILE 2>/dev/null || true)
CURL_BIN=$(printenv CANDIDATE_CURL_BIN 2>/dev/null || true)
[ -n "$CURL_BIN" ] || CURL_BIN=curl
TMP_DIR=$(mktemp -d)
chmod 700 "$TMP_DIR"
auth_cfg=; trap 'unset password gemini_key client_key client_id; rm -f "${auth_cfg:-}"; rm -rf "$TMP_DIR"' EXIT HUP INT TERM

die() { printf '9R-PROVISION-%s\n' "$1" >&2; exit "$2"; }
need() { [ -n "$2" ] || die "$3" "$4"; }
secure_file() { [ -n "$1" ] && [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -c '%a' "$1" 2>/dev/null || printf 0)" = 600 ]; }
read_secret() {
  if [ -n "$1" ]; then secure_file "$1" || return 1; cat "$1"; return; fi
  if [ -n "$2" ]; then case "$2" in *[!0-9]*) return 1;; esac; eval "cat <&$2"; return; fi
  return 1
}
write_output() {
  target=$1
  value=$2
  [ -n "$target" ] && [ ! -L "$target" ] || return 1
  parent=$(dirname "$target")
  [ ! -L "$parent" ] && [ -d "$parent" ] || return 1
  temp=$(mktemp "$parent/.candidate-output.XXXXXX") || return 1
  printf '%s\n' "$value" >"$temp" || { rm -f "$temp"; return 1; }
  chmod 600 "$temp" && mv "$temp" "$target" || { rm -f "$temp"; return 1; }
}

need URL "$CANDIDATE_URL" URL-001 10
need PASSWORD "$PASSWORD_FILE$PASSWORD_FD" SECRET-001 11
need GEMINI "$GEMINI_KEY_FILE$GEMINI_KEY_FD" SECRET-002 12
need CLIENT_KEY_FILE "$CLIENT_KEY_FILE" OUTPUT-001 13
need CLIENT_ID_FILE "$CLIENT_ID_FILE" OUTPUT-002 14
case "$CANDIDATE_URL" in
  http://127.0.0.1:*) candidate_port=${CANDIDATE_URL#http://127.0.0.1:} ;;
  *) die LOOPBACK-001 15 ;;
esac
case "$candidate_port" in ''|*[!0-9]*) die LOOPBACK-001 15 ;; esac
candidate_port_dec=$(printf '%s' "$candidate_port" | sed 's/^0*//')
[ -n "$candidate_port_dec" ] || die LOOPBACK-001 15
case "$candidate_port_dec" in ??????*) die LOOPBACK-001 15 ;; esac
[ "$candidate_port_dec" -ge 1 ] 2>/dev/null && [ "$candidate_port_dec" -le 65535 ] || die LOOPBACK-001 15
[ "$candidate_port_dec" -ne 20128 ] || die LOOPBACK-002 16
password=$(read_secret "$PASSWORD_FILE" "$PASSWORD_FD" 2>/dev/null || true)
[ -n "$password" ] || die SECRET-003 16
printf '%s' "$password" | awk 'length($0)>=16 {ok=1} END{exit(ok?0:1)}' || die SECRET-003 16
case "$password" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~!@%+=,-]*) die SECRET-004 17;; esac
gemini_key=$(read_secret "$GEMINI_KEY_FILE" "$GEMINI_KEY_FD" 2>/dev/null || true)
[ -n "$gemini_key" ] || die SECRET-005 18
case "$gemini_key" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-]*) die SECRET-006 19;; esac

printf '{"password":"%s"}\n' "$password" >"$TMP_DIR/password.json"
cookie="$TMP_DIR/cookie.jar"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/login-status.json" --write-out '%{http_code}' --max-time 15 "$CANDIDATE_URL/api/auth/status" 2>/dev/null || true)
[ "$code" = 200 ] || die DASHBOARD-001 30
code=$("$CURL_BIN" --silent --output "$TMP_DIR/login.json" --write-out '%{http_code}' --max-time 15 -c "$cookie" -H 'Content-Type: application/json' --data-binary "@$TMP_DIR/password.json" "$CANDIDATE_URL/api/auth/login" 2>/dev/null || true)
[ "$code" = 200 ] || die DASHBOARD-002 31

printf '{"provider":"gemini","apiKey":"%s","providerSpecificData":{}}\n' "$gemini_key" >"$TMP_DIR/provider-validate.json"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/provider-validate-result.json" --write-out '%{http_code}' --max-time 30 -b "$cookie" -H 'Content-Type: application/json' --data-binary "@$TMP_DIR/provider-validate.json" "$CANDIDATE_URL/api/providers/validate" 2>/dev/null || true)
[ "$code" = 200 ] || die PROVIDER-VALIDATE-001 40
grep -Eq '"valid"[[:space:]]*:[[:space:]]*true' "$TMP_DIR/provider-validate-result.json" || die PROVIDER-VALIDATE-002 41

printf '{"provider":"gemini","name":"Gemini","apiKey":"%s","testStatus":"passed"}\n' "$gemini_key" >"$TMP_DIR/provider-create.json"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/provider-create-result.json" --write-out '%{http_code}' --max-time 30 -b "$cookie" -H 'Content-Type: application/json' --data-binary "@$TMP_DIR/provider-create.json" "$CANDIDATE_URL/api/providers" 2>/dev/null || true)
[ "$code" = 201 ] || die PROVIDER-CREATE-001 42
grep -Eq '"connection"[[:space:]]*:' "$TMP_DIR/provider-create-result.json" || die PROVIDER-CREATE-002 43

printf '{"name":"miyabi-bot-candidate"}\n' >"$TMP_DIR/client-key-create.json"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/client-key-result.json" --write-out '%{http_code}' --max-time 15 -b "$cookie" -H 'Content-Type: application/json' --data-binary "@$TMP_DIR/client-key-create.json" "$CANDIDATE_URL/api/keys" 2>/dev/null || true)
[ "$code" = 201 ] || die CLIENT-001 50
client_key=$(sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/client-key-result.json" | head -n 1)
client_id=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/client-key-result.json" | head -n 1)
printf '%s' "$client_key" | grep -Eq '^sk-[a-zA-Z0-9_-]{8,}$' || die CLIENT-002 51
printf '%s' "$client_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || die CLIENT-003 52
write_output "$CLIENT_KEY_FILE" "$client_key" || die OUTPUT-003 53
write_output "$CLIENT_ID_FILE" "$client_id" || die OUTPUT-004 54

auth_cfg="$TMP_DIR/client-auth.conf"
printf 'header = "Authorization: Bearer %s"\n' "$client_key" >"$auth_cfg"
chmod 600 "$auth_cfg"
code=$("$CURL_BIN" --silent --output "$TMP_DIR/models.json" --write-out '%{http_code}' --max-time 15 --config "$auth_cfg" "$CANDIDATE_URL/v1/models" 2>/dev/null || true)
[ "$code" = 200 ] || die CLIENT-005 55
grep -Fq '"gemini/gemini-3.6-flash"' "$TMP_DIR/models.json" || die CLIENT-006 56
printf '9R-PROVISION-OK\n'
