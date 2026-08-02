#!/bin/sh
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/bin" "$root/out"
printf 'StrongCandidatePass123!\n' >"$root/password"
printf 'AIzaGeminiKey_123456789\n' >"$root/gemini"
chmod 600 "$root/password" "$root/gemini"
cat >"$root/bin/curl" <<'EOF'
#!/bin/sh
scenario=${MOCK_SCENARIO:-}
[ -z "${MOCK_ARG_LOG:-}" ] || printf '%s\n' "$*" >>"${MOCK_ARG_LOG}"
url=
out=
write=0
prev=
for arg in "$@"; do
  case "$arg" in http://*) url=$arg;; esac
  [ "$prev" = -o ] || [ "$prev" = --output ] && out=$arg
  [ "$arg" = -w ] || [ "$arg" = --write-out ] && write=1
  prev=$arg
done
case "$url" in
  */api/auth/status)
    if [ "$scenario" = status-fail ]; then code=500; else printf '{"requireLogin":true,"hasPassword":false}\n' >"$out"; code=200; fi ;;
  */api/auth/login)
    if [ "$scenario" = login-fail ]; then code=401; else printf '{"success":true}\n' >"$out"; code=200; fi ;;
  */api/providers/validate)
    if [ "$scenario" = validate-fail ]; then code=500; elif [ "$scenario" = validate-shape ]; then printf '{"valid":false}\n' >"$out"; code=200; else printf '{"valid":true}\n' >"$out"; code=200; fi ;;
  */api/providers)
    if [ "$scenario" = provider-fail ]; then code=500; elif [ "$scenario" = provider-shape ]; then printf '{}\n' >"$out"; code=201; else printf '{"connection":{"id":"provider-1"}}\n' >"$out"; code=201; fi ;;
  */api/keys)
    if [ "$scenario" = key-fail ]; then code=500; elif [ "$scenario" = key-bad ]; then printf '{"key":"bad","id":"00000000-0000-0000-0000-000000000001","machineId":"machine"}\n' >"$out"; code=201; elif [ "$scenario" = key-bad-id ]; then printf '{"key":"sk-client-key-12345678","id":"00000000-0000-0000-0000-00000000000","machineId":"machine"}\n' >"$out"; code=201; elif [ "$scenario" = key-shape ]; then printf '{"id":"00000000-0000-0000-0000-000000000001"}\n' >"$out"; code=201; else printf '{"key":"sk-client-key-12345678","id":"00000000-0000-0000-0000-000000000001","machineId":"machine"}\n' >"$out"; code=201; fi ;;
  */v1/models)
    if [ "$scenario" = models-fail ]; then code=500; elif [ "$scenario" = models-shape ]; then printf '{"data":[]}\n' >"$out"; code=200; else printf '{"data":[{"id":"gemini/gemini-3.6-flash"}]}\n' >"$out"; code=200; fi ;;
  *) code=500 ;;
esac
[ "$write" = 1 ] && printf '%s' "$code"
exit 0
EOF
chmod 700 "$root/bin/curl"
run_provision() {
  scenario=$1
  PATH="$root/bin:$PATH" CANDIDATE_CURL_BIN="$root/bin/curl" MOCK_SCENARIO="$scenario" MOCK_ARG_LOG="$root/args-$scenario" \
    CANDIDATE_URL="${TEST_URL:-http://127.0.0.1:20129}" \
    CANDIDATE_PASSWORD_FILE="${TEST_PASSWORD_FILE:-$root/password}" CANDIDATE_GEMINI_KEY_FILE="${TEST_GEMINI_FILE:-$root/gemini}" \
    CANDIDATE_API_KEY_FILE="${TEST_KEY_OUT:-$root/out/client-key}" CANDIDATE_CLIENT_KEY_ID_FILE="${TEST_ID_OUT:-$root/out/client-id}" \
    sh ops/provision-9router-candidate.sh
}
assert_clean() {
  value=$1
  log_file=$2
  printf '%s\n' "$value" | grep -Fq 'StrongCandidatePass123!' && exit 1 || true
  printf '%s\n' "$value" | grep -Fq 'AIzaGeminiKey_123456789' && exit 1 || true
  printf '%s\n' "$value" | grep -Fq 'sk-client-key-12345678' && exit 1 || true
  [ ! -f "$log_file" ] || { grep -Fq 'StrongCandidatePass123!' "$log_file" && exit 1 || true; }
  [ ! -f "$log_file" ] || { grep -Fq 'AIzaGeminiKey_123456789' "$log_file" && exit 1 || true; }
  [ ! -f "$log_file" ] || { grep -Fq 'sk-client-key-12345678' "$log_file" && exit 1 || true; }
}
expect_success() {
  label=$1
  output=$(run_provision "$label" 2>&1)
  printf '%s\n' "$output" | grep -Fq '9R-PROVISION-OK'
  assert_clean "$output" "$root/args-$label"
}
expect_fail() {
  label=$1
  if output=$(run_provision "$label" 2>&1); then exit 1; fi
  printf '%s\n' "$output" | grep -Eq '^9R-PROVISION-'
  assert_clean "$output" "$root/args-$label"
}
expect_success happy
TEST_URL=http://localhost:20129
expect_fail localhost
unset TEST_URL
TEST_URL=http://127.0.0.1:123abc
expect_fail malformed-port
TEST_URL=http://127.0.0.1:0
expect_fail zero-port
TEST_URL=http://127.0.0.1:65536
expect_fail range-port
TEST_URL=http://127.0.0.1:20128
expect_fail production-port
chmod 644 "$root/password"
expect_fail password-mode
chmod 600 "$root/password"
ln -s "$root/password" "$root/password-link"
TEST_PASSWORD_FILE="$root/password-link"
expect_fail password-link
unset TEST_PASSWORD_FILE
rm "$root/password-link"
chmod 644 "$root/gemini"
expect_fail gemini-mode
chmod 600 "$root/gemini"
ln -s "$root/gemini" "$root/gemini-link"
TEST_GEMINI_FILE="$root/gemini-link"
expect_fail gemini-link
unset TEST_GEMINI_FILE
rm "$root/gemini-link"
ln -s "$root/out" "$root/out-link"
TEST_KEY_OUT="$root/out-link/client-key"
expect_fail output-parent-link
unset TEST_KEY_OUT
rm "$root/out-link"
printf 'untouched\n' >"$root/out/target"
ln -s "$root/out/target" "$root/out/key-link"
TEST_KEY_OUT="$root/out/key-link"
expect_fail output-target-link
unset TEST_KEY_OUT
rm "$root/out/key-link" "$root/out/target"
expect_fail status-fail
expect_fail login-fail
expect_fail validate-fail
expect_fail validate-shape
expect_fail provider-fail
expect_fail provider-shape
expect_fail key-fail
expect_fail key-shape
expect_fail key-bad
expect_fail key-bad-id
expect_fail models-fail
expect_fail models-shape
printf 'ok\n'
