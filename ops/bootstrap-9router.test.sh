#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bootstrap="$script_dir/bootstrap-9router.sh"
root=
trap 'if [ -n "${root:-}" ]; then chmod -R u+w "$root" 2>/dev/null || true; rm -rf "$root"; fi' EXIT HUP INT TERM

write_mocks() {
  mkdir -p "$root/bin"
  cat > "$root/bin/docker" <<'EOF'
#!/bin/sh
case "$*" in
  *"ps -q 9router"*) printf 'test-cid\n' ;;
  *"port test-cid 20128/tcp"*) printf '%s\n' "${MOCK_BIND:-127.0.0.1:20128}" ;;
  *"exec -T 9router node"*"SELECT id, name, createdAt"*) printf '[{"id":"00000000-0000-0000-0000-000000000001","name":"ci","createdAt":"2026-08-02T00:00:00.000Z"}]\n' ;;
  *"exec -T bot-prod node"*) printf '00000000-0000-0000-0000-000000000001\n' ;;
  *"exec -T 9router node"*"SELECT key"*) printf 'sk-secret-key\n' ;;
  *) : ;;
esac
EOF
  chmod 700 "$root/bin/docker"
  cat > "$root/bin/curl" <<'EOF'
#!/bin/sh
printf '200'
EOF
  chmod 700 "$root/bin/curl"
}

assert_status() {
  status_path=$1
  expected_state=$2
  expected_code=$3
  [ -f "$status_path" ]
  [ "$(stat -c '%a' "$status_path")" = 600 ]
  status=$(cat "$status_path")
  printf '%s\n' "$status" | grep -Eq '^\{"module":"key-sync","state":"(ready|degraded)","lastSuccessAt":(null|"[^"]+"),"lastErrorAt":(null|"[^"]+"),"errorCode":(null|"[^"]+")\}$'
  case "$expected_state:$expected_code" in
    ready:) printf '%s\n' "$status" | grep -Eq '^\{"module":"key-sync","state":"ready","lastSuccessAt":"[^"]+","lastErrorAt":null,"errorCode":null\}$' ;;
    degraded:KEY-SYNC-001) printf '%s\n' "$status" | grep -Eq '^\{"module":"key-sync","state":"degraded","lastSuccessAt":null,"lastErrorAt":"[^"]+","errorCode":"KEY-SYNC-001"\}$' ;;
    *) echo "unexpected status expectation" >&2; exit 1 ;;
  esac
}

run_sync_key() {
  MOCK_BIND=$1 PATH="$root/bin:$PATH" PROJECT_DIR="$root" STATUS_DIR="$root/status" \
    MIYABI_OPS_LOCK_HELD=1 "$bootstrap" sync-key
}

# Fresh failure records a fixed degraded status without exposing command errors.
root=$(mktemp -d)
write_mocks
mkdir -p "$root/status" "$root/data"
if output=$(run_sync_key 0.0.0.0:20128 2>&1); then
  echo "invalid binding unexpectedly succeeded" >&2
  exit 1
fi
assert_status "$root/status/key-sync.json" degraded KEY-SYNC-001
printf '%s' "$output" | grep -Eq 'sk-secret-key|Error|stack|node:' && {
  echo "raw secret or error leaked" >&2
  exit 1
}
find "$root" -type f -name '*.tmp*' -o -name 'key-sync.json.*' | grep -q . && {
  echo "temporary key-sync status file remains" >&2
  exit 1
}
rm -rf "$root"
root=

# Successful key-sync writes the same five fields and keeps the secret out of status/metadata.
root=$(mktemp -d)
write_mocks
mkdir -p "$root/status" "$root/data"
printf 'AI_API_KEY=sk-secret-key\n' > "$root/.env"
if output=$(run_sync_key 127.0.0.1:20128 2>&1); then :; else
  printf '%s\n' "$output" >&2
  exit 1
fi
assert_status "$root/status/key-sync.json" ready ""
[ "$(stat -c '%a' "$root/status")" = 700 ]
[ -f "$root/data/9router-api-keys.json" ]
if grep -Eq 'sk-secret-key|Error:|stack trace|node:' "$root/status/key-sync.json" "$root/data/9router-api-keys.json"; then
  echo "secret or raw error persisted" >&2
  exit 1
fi
rm -rf "$root"
root=

# A symlinked status directory is fail-closed and does not create a file in its referent.
root=$(mktemp -d)
write_mocks
mkdir -p "$root/status-target" "$root/data"
ln -s "$root/status-target" "$root/status"
if run_sync_key 0.0.0.0:20128 >/dev/null 2>&1; then
  echo "symlinked status directory unexpectedly succeeded" >&2
  exit 1
fi
[ -z "$(ls -A "$root/status-target")" ]
find "$root" -type f -name '*.tmp*' -o -name 'key-sync.json.*' | grep -q . && {
  echo "temporary file remains after status directory rejection" >&2
  exit 1
}
rm -rf "$root"
root=

# A symlinked status target is rejected without changing its referent.
root=$(mktemp -d)
write_mocks
mkdir -p "$root/status" "$root/data"
printf 'sentinel\n' > "$root/status/referent.json"
ln -s "$root/status/referent.json" "$root/status/key-sync.json"
if run_sync_key 0.0.0.0:20128 >/dev/null 2>&1; then
  echo "symlinked status target unexpectedly succeeded" >&2
  exit 1
fi
[ "$(cat "$root/status/referent.json")" = sentinel ]
[ -L "$root/status/key-sync.json" ]
find "$root" -type f -name '*.tmp*' -o -name 'key-sync.json.*' | grep -q . && {
  echo "temporary file remains after status target rejection" >&2
  exit 1
}

echo ok
