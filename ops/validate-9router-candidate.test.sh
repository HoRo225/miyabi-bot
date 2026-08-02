#!/bin/sh
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/bin" "$root/status" "$root/data"
printf 'StrongCandidatePass123!\n' >"$root/password"
printf 'AIzaGeminiKey_123456789\n' >"$root/gemini"
printf 'sk-test-key-12345678\n' >"$root/api-key"
printf '00000000-0000-0000-0000-000000000001\n' >"$root/client-id"
chmod 600 "$root/password" "$root/gemini" "$root/api-key" "$root/client-id"
printf '%s\n' '{"Descriptor":{"digest":"sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9","platform":{"architecture":"amd64","os":"linux"}},"SchemaV2Manifest":{}}' >"$root/manifest.json"
chmod 600 "$root/manifest.json"
cat >"$root/bin/docker" <<'EOF'
#!/bin/sh
scenario=${MOCK_SCENARIO:-}
[ -z "${MOCK_ARG_LOG:-}" ] || printf '%s\n' "$*" >>"$MOCK_ARG_LOG"
case "$scenario:$*" in
  platform:*"image inspect --format {{.Os}}/{{.Architecture}}"*) printf 'linux/arm64\n' ;;
  revision:*"image inspect --format {{index .Config.Labels"*) printf 'bad-revision\n' ;;
  mount:*"inspect --format {{range .Mounts"*) printf 'wrong-volume\n' ;;
  old-volume:*"inspect --format {{range .Mounts"*) printf 'horo-discord-bot_9router-data\n' ;;
  ref:*"inspect --format {{.Config.Image}}"*) printf 'wrong/image:latest\n' ;;
  port-production:*"port candidate-cid 20128/tcp"*) printf '127.0.0.1:20128\n' ;;
  volume-marker:*"exec candidate-cid"*"grep -R"*) printf 'marker-123\n'; exit 0 ;;
  grep-error:*"exec candidate-cid"*"grep -R"*) exit 2 ;;
  *"inspect --format {{.Image}}"*) printf 'image-id\n' ;;
  *"image inspect --format {{.Os}}/{{.Architecture}}"*) printf 'linux/amd64\n' ;;
  repo-digest-prefix:*"image inspect --format {{json .RepoDigests}}"*) printf '%s\n' '["decolua/9router@sha256:007b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9"]' ;;
  repo-digest-suffix:*"image inspect --format {{json .RepoDigests}}"*) printf '%s\n' '["decolua/9router@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe900"]' ;;
  repo-digest-malformed:*"image inspect --format {{json .RepoDigests}}"*) printf '%s\n' 'not-json' ;;
  *"image inspect --format {{json .RepoDigests}}"*) printf '%s\n' '["decolua/9router@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9"]' ;;
  *"manifest inspect --verbose decolua/9router@sha256:"*) printf '%s\n' '{"Descriptor":{"digest":"sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9","platform":{"architecture":"amd64","os":"linux"}},"SchemaV2Manifest":{}}' ;;
  *"image inspect --format {{index .Config.Labels"*) printf '6fcd27337a7893642c7fe630840d0a641743f28f\n' ;;
  *"inspect --format {{.Config.Image}}"*) printf 'decolua/9router@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9\n' ;;
  *"inspect --format {{range .Mounts"*) printf 'candidate-volume\n' ;;
  *"port candidate-cid 20128/tcp"*) printf '127.0.0.1:20129\n' ;;
  *"exec candidate-cid"*"grep -R"*) exit 1 ;;
  *"logs candidate-cid"*)
    [ "$scenario" = log-marker ] && printf 'marker-123\n'
    [ "$scenario" = secret-container ] && cat "$MOCK_SECRET_API_FILE"
    exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod 700 "$root/bin/docker"
cat >"$root/bin/curl" <<'EOF'
#!/bin/sh
scenario=${MOCK_SCENARIO:-}
[ -z "${MOCK_ARG_LOG:-}" ] || printf '%s\n' "$*" >>"$MOCK_ARG_LOG"
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
  */api/auth/status) printf '{"requireLogin":true,"hasPassword":true}\n' >"$out"; code=200 ;;
  */api/auth/login) printf '{"success":true}\n' >"$out"; code=200 ;;
  */api/keys) printf '{"keys":[{"id":"00000000-0000-0000-0000-000000000001"}]}\n' >"$out"; code=200 ;;
  */api/settings) printf '{"enableObservability2":false}\n' >"$out"; code=200 ;;
  */v1/models)
    case "$*:$scenario" in *"--config"*:models-auth-fail*) printf '{}\n' >"$out"; code=500 ;; *"--config"*:models-no-model*) printf '{"data":[]}\n' >"$out"; code=200 ;; *"--config"*) printf '{"data":[{"id":"gemini/gemini-3.6-flash"}]}\n' >"$out"; code=200 ;; *) printf '{}\n' >"$out"; code=401 ;; esac ;;
  */api/usage/stats*)
    if [ "$scenario" = usage-no-increment ]; then printf '{"requests":0}\n' >"$out"; elif [ -f "$MOCK_USAGE_FILE" ]; then printf '{"requests":1}\n' >"$out"; else printf '{"requests":0}\n' >"$out"; : >"$MOCK_USAGE_FILE"; fi
    code=200 ;;
  */v1/chat/completions) [ "$scenario" = canary-fail ] && { printf '{}\n' >"$out"; code=500; } || { printf '{"choices":[{"message":{"content":"ok"}}]}\n' >"$out"; code=200; } ;;
  */api/usage/request-details|*/api/usage/logs)
    if [ "$scenario" = endpoint-fail ]; then printf '{}\n' >"$out"; code=500; elif [ "$scenario" = api-marker ]; then printf '{"details":["marker-123"]}\n' >"$out"; code=200; elif [ "$scenario" = secret-api ]; then printf '{"details":[' >>"$out"; cat "$MOCK_SECRET_PASSWORD_FILE" >>"$out"; printf ']}\n' >>"$out"; code=200; elif [ "$scenario" = secret-logs ] && ! printf '%s' "$url" | grep -Fq request-details; then printf '[' >"$out"; cat "$MOCK_SECRET_GEMINI_FILE" >>"$out"; printf ']\n' >>"$out"; code=200; elif printf '%s' "$url" | grep -Fq request-details; then printf '{"details":[],"pagination":{}}\n' >"$out"; code=200; else printf '[]\n' >"$out"; code=200; fi ;;
  *) code=500 ;;
esac
[ "$write" = 1 ] && printf '%s' "$code"
exit 0
EOF
chmod 700 "$root/bin/curl"
cat >"$root/bin/grep" <<'EOF'
#!/bin/sh
[ -z "${MOCK_GREP_ARG_LOG:-}" ] || printf '%s\n' "$*" >>"$MOCK_GREP_ARG_LOG"
exec /usr/bin/grep "$@"
EOF
chmod 700 "$root/bin/grep"

IMAGE='decolua/9router@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9'
run_validator() {
  scenario=$1
  PATH="$root/bin:$PATH" MOCK_SCENARIO="$scenario" MOCK_USAGE_FILE="$root/usage-$scenario" MOCK_ARG_LOG="$root/args-$scenario" \
    MOCK_SECRET_PASSWORD_FILE="$root/password" MOCK_SECRET_GEMINI_FILE="$root/gemini" MOCK_SECRET_API_FILE="$root/api-key" \
    MOCK_GREP_ARG_LOG="$root/grep-$scenario" \
    CANDIDATE_URL="${TEST_URL:-http://127.0.0.1:20129}" CANDIDATE_CONTAINER=candidate-cid CANDIDATE_IMAGE="${TEST_IMAGE:-$IMAGE}" \
    CANDIDATE_VOLUME="${TEST_VOLUME:-candidate-volume}" CANDIDATE_MANIFEST_FILE="${TEST_MANIFEST_FILE-$root/manifest.json}" \
    CANDIDATE_PASSWORD_FILE="${TEST_PASSWORD_FILE:-$root/password}" CANDIDATE_GEMINI_KEY_FILE="${TEST_GEMINI_FILE:-$root/gemini}" CANDIDATE_API_KEY_FILE="${TEST_API_FILE:-$root/api-key}" \
    CANDIDATE_CLIENT_KEY_ID_FILE="${TEST_ID_FILE:-$root/client-id}" CANDIDATE_MARKER=marker-123 \
    CANDIDATE_EXPECTED_DIGEST="${TEST_EXPECTED_DIGEST:-}" CANDIDATE_EXPECTED_REVISION="${TEST_EXPECTED_REVISION:-}" \
    CANDIDATE_EXPECTED_PLATFORM="${TEST_EXPECTED_PLATFORM:-}" CANDIDATE_TEST_MODE="${TEST_MODE:-}" \
    CANDIDATE_USAGE_POLL_ATTEMPTS="${TEST_POLL:-}" \
    PRODUCTION_VALIDATION="${PROD_VALIDATION:-}" sh ops/validate-9router-candidate.sh
}
assert_clean() {
  value=$1
  log_file=$2
  grep_log=${3:-}
  printf '%s\n' "$value" | grep -Fq 'StrongCandidatePass123!' && exit 1 || true
  printf '%s\n' "$value" | grep -Fq 'AIzaGeminiKey_123456789' && exit 1 || true
  printf '%s\n' "$value" | grep -Fq 'sk-test-key-12345678' && exit 1 || true
  [ ! -f "$log_file" ] || { grep -Fq 'StrongCandidatePass123!' "$log_file" && exit 1 || true; }
  [ ! -f "$log_file" ] || { grep -Fq 'AIzaGeminiKey_123456789' "$log_file" && exit 1 || true; }
  [ ! -f "$log_file" ] || { grep -Fq 'sk-test-key-12345678' "$log_file" && exit 1 || true; }
  [ -z "$grep_log" ] || [ ! -f "$grep_log" ] || { grep -Fq 'StrongCandidatePass123!' "$grep_log" && exit 1 || true; }
  [ -z "$grep_log" ] || [ ! -f "$grep_log" ] || { grep -Fq 'AIzaGeminiKey_123456789' "$grep_log" && exit 1 || true; }
  [ -z "$grep_log" ] || [ ! -f "$grep_log" ] || { grep -Fq 'sk-test-key-12345678' "$grep_log" && exit 1 || true; }
}
expect_success() {
  label=$1
  output=$(run_validator "$label" 2>&1)
  printf '%s\n' "$output" | grep -Fq '9R-CANDIDATE-OK'
  grep -Fq -- ' -f ' "$root/grep-$label"
  assert_clean "$output" "$root/args-$label" "$root/grep-$label"
}
expect_fail() {
  label=$1
  if output=$(run_validator "$label" 2>&1); then exit 1; fi
  printf '%s\n' "$output" | grep -Eq '^9R-CANDIDATE-'
  assert_clean "$output" "$root/args-$label" "$root/grep-$label"
}
expect_preflight_fail() {
  label=$1
  code=$2
  if output=$(run_validator "$label" 2>&1); then exit 1; fi
  printf '%s\n' "$output" | grep -Fq "9R-CANDIDATE-$code"
  [ ! -s "$root/args-$label" ] || exit 1
  [ ! -s "$root/grep-$label" ] || exit 1
  assert_clean "$output" "$root/args-$label" "$root/grep-$label"
}
expect_secret_log_fail() {
  label=$1
  if output=$(run_validator "$label" 2>&1); then exit 1; fi
  printf '%s\n' "$output" | grep -Fq '9R-CANDIDATE-SECRET-LOG-001'
  grep -Fq -- ' -f ' "$root/grep-$label"
  assert_clean "$output" "$root/args-$label" "$root/grep-$label"
}
expect_success happy
TEST_IMAGE='decolua/9router:0.5.45@sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9'
expect_preflight_fail tag-child-image IMAGE-002
unset TEST_IMAGE
TEST_MANIFEST_FILE=
expect_success manifest-fetch
unset TEST_MANIFEST_FILE
TEST_MODE=1
expect_success test-mode-fixed
expect_fail repo-digest-prefix
expect_fail repo-digest-suffix
expect_fail repo-digest-malformed
TEST_EXPECTED_DIGEST=sha256:bad
expect_preflight_fail test-mode-override EXPECTATION-001
unset TEST_MODE TEST_EXPECTED_DIGEST
TEST_EXPECTED_DIGEST=sha256:bad
expect_preflight_fail override-digest EXPECTATION-001
unset TEST_EXPECTED_DIGEST
TEST_EXPECTED_REVISION=bad-revision
expect_preflight_fail override-revision EXPECTATION-001
unset TEST_EXPECTED_REVISION
TEST_EXPECTED_PLATFORM=linux/arm64
expect_preflight_fail override-platform EXPECTATION-001
unset TEST_EXPECTED_PLATFORM
TEST_MODE=1
PROD_VALIDATION=1
expect_preflight_fail production-test-mode TEST-MODE-001
unset TEST_MODE PROD_VALIDATION
sed 's/sha256:7b/sha256:007b/' "$root/manifest.json" >"$root/manifest-digest-prefix.json"
sed 's/f95fe9/f95fe900/' "$root/manifest.json" >"$root/manifest-digest-suffix.json"
printf '%s\n' '[{"Descriptor":{"digest":"sha256:7b264fd1925717425e9dc01d33bea75621aa7d77684e66758bceeb8463f95fe9","platform":{"architecture":"amd64","os":"linux"}},"SchemaV2Manifest":{}}]' >"$root/manifest-array.json"
printf '%s\n' 'not-json' >"$root/manifest-malformed.json"
chmod 600 "$root/manifest-digest-prefix.json" "$root/manifest-digest-suffix.json" "$root/manifest-array.json" "$root/manifest-malformed.json"
TEST_MANIFEST_FILE="$root/manifest-digest-prefix.json"
expect_fail manifest-digest-prefix
unset TEST_MANIFEST_FILE
TEST_MANIFEST_FILE="$root/manifest-array.json"
expect_fail manifest-array
unset TEST_MANIFEST_FILE
TEST_MANIFEST_FILE="$root/manifest-digest-suffix.json"
expect_fail manifest-digest-suffix
unset TEST_MANIFEST_FILE
TEST_MANIFEST_FILE="$root/manifest-malformed.json"
expect_fail manifest-malformed
unset TEST_MANIFEST_FILE
TEST_URL=http://localhost:20129
expect_fail localhost
unset TEST_URL
TEST_URL=http://127.0.0.1:20128
expect_fail production-port
PROD_VALIDATION=1
expect_success port-production
unset TEST_URL PROD_VALIDATION
TEST_VOLUME=horo-discord-bot_9router-data
expect_fail old-volume
unset TEST_VOLUME
expect_fail mount
expect_fail ref
expect_fail revision
expect_fail platform
for bad_id in \
  0000000-0000-0000-0000-000000000001 \
  00000000-000-0000-0000-000000000001 \
  00000000-0000-000-0000-000000000001 \
  00000000-0000-0000-000-000000000001 \
  00000000-0000-0000-0000-00000000001; do
  printf '%s\n' "$bad_id" >"$root/client-id"
  expect_fail uuid
done
printf '00000000-0000-0000-0000-000000000001\n' >"$root/client-id"
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
chmod 644 "$root/api-key"
expect_fail api-mode
chmod 600 "$root/api-key"
ln -s "$root/api-key" "$root/api-link"
TEST_API_FILE="$root/api-link"
expect_fail api-link
unset TEST_API_FILE
rm "$root/api-link"
chmod 644 "$root/client-id"
expect_fail id-mode
chmod 600 "$root/client-id"
ln -s "$root/client-id" "$root/id-link"
TEST_ID_FILE="$root/id-link"
expect_fail id-link
unset TEST_ID_FILE
rm "$root/id-link"
expect_fail models-auth-fail
expect_fail models-no-model
TEST_POLL=1
expect_fail usage-no-increment
unset TEST_POLL
TEST_POLL=abc
expect_fail invalid-poll
TEST_POLL=0
expect_fail zero-poll
TEST_POLL=301
expect_fail high-poll
unset TEST_POLL
expect_fail endpoint-fail
expect_fail api-marker
expect_fail volume-marker
expect_fail log-marker
expect_secret_log_fail secret-api
expect_secret_log_fail secret-logs
expect_secret_log_fail secret-container
expect_fail grep-error
printf 'ok\n'
