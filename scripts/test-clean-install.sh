#!/bin/sh
# scripts/test-clean-install.sh — the test that decides whether Kodo is installable.
#
# Everything else verifies the source tree. This verifies the ARTIFACT: build a
# release, serve it, install it into an empty prefix, then use the installed
# Kodo with the repository made unreachable.
#
# The last part is the point. A CLI that works because it happens to sit next to
# its own source is not installed, it is being run in place — and that failure
# is invisible from inside the repository, which is exactly where people test.
#
# Scenario:
#   1. clean install from a release artifact
#   2. kodo --version, from / and with a scrubbed environment
#   3. NO source-repository dependency (proved by moving the repo away)
#   4. kodo doctor
#   5. kodo init in a throwaway project
#   6. kodo run   (offline-safe: no provider configured ⇒ must exit 4, not hang)
#   7. kodo ui start / status / stop, from outside the repo
#   8. upgrade over an existing install
#   9. uninstall
#
# Nothing touches the real ~/.kodo or the developer's PATH.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
SERVE="${WORK}/serve"
PREFIX="${WORK}/prefix/bin"
HOME_DIR="${WORK}/home"
PROJECT="${WORK}/project"
PORT="${KODO_CLEAN_TEST_PORT:-8742}"
BASE="http://127.0.0.1:${PORT}"

pass=0; fail=0; SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  # Best effort: stop anything the UI test left behind.
  if [ -x "${PREFIX}/kodo" ]; then
    HOME="$HOME_DIR" "${PREFIX}/kodo" ui stop >/dev/null 2>&1 || true
    HOME="$HOME_DIR" "${PREFIX}/kodo" server stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

ok()  { printf '  \033[32m✅\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1"; printf '     %s\n' "${2:-}"; fail=$((fail+1)); }

printf '\n📦 clean-machine install — the artifact, not the repository\n\n'

VERSION="$(node -p "require('${REPO}/cli/package.json').version")"
PLATFORM="$(uname -s | tr 'A-Z' 'a-z')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"

# ── Build + serve ────────────────────────────────────────────────────────────
printf '  … building a release artifact (this bundles dependencies)\n'
if ! node "${REPO}/scripts/build-release.mjs" --out "${WORK}/dist" --platform "$PLATFORM" >"${WORK}/build.log" 2>&1; then
  bad "build the artifact" "$(tail -3 "${WORK}/build.log")"; exit 1
fi
ok "built a self-contained artifact for ${PLATFORM}"

mkdir -p "${SERVE}/releases/${VERSION}"
cp "${WORK}/dist/"*.tar.gz "${WORK}/dist/SHA256SUMS" "${SERVE}/releases/${VERSION}/"
cp "${WORK}/dist/latest.txt" "${SERVE}/releases/"
(cd "$SERVE" && exec python3 -m http.server "$PORT" >/dev/null 2>&1) &
SERVER_PID=$!
i=0; while [ $i -lt 60 ]; do curl -fsS "${BASE}/releases/latest.txt" >/dev/null 2>&1 && break; i=$((i+1)); sleep 0.1; done

# ── 1. Install ───────────────────────────────────────────────────────────────
mkdir -p "$HOME_DIR" "$PROJECT"
if env KODO_BASE_URL="$BASE" KODO_INSTALL_DIR="$PREFIX" HOME="$HOME_DIR" \
     sh "${REPO}/install.sh" >"${WORK}/install.log" 2>&1; then
  ok "installed from the release artifact"
else
  bad "install from the release artifact" "$(tail -5 "${WORK}/install.log")"; exit 1
fi

# No npm install may have happened at install time.
if grep -qi "installing dependencies" "${WORK}/install.log"; then
  bad "the artifact is self-contained" "the installer ran a dependency install"
else
  ok "no dependency install was needed at install time"
fi

# ── 2/3. Runs with the repository unreachable ────────────────────────────────
# This is the decisive check. Move the repo aside so any repository-relative
# import or cwd assumption fails loudly instead of silently succeeding.
MOVED="${WORK}/repo-moved-away"
run_installed() {
  env -i HOME="$HOME_DIR" PATH="${PREFIX}:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM=dumb NO_COLOR=1 "${PREFIX}/kodo" "$@" 2>&1
}

if reported="$(cd / && run_installed --version)"; then
  [ "$reported" = "$VERSION" ] \
    && ok "kodo --version works from / with a scrubbed environment" \
    || bad "kodo --version" "got '${reported}', wanted '${VERSION}'"
else
  bad "kodo --version" "$reported"
fi

# ── 4. doctor ────────────────────────────────────────────────────────────────
doc="$(cd / && run_installed doctor || true)"
case "$doc" in
  *"Kodo CLI"*) ok "kodo doctor runs on a fresh install" ;;
  *) bad "kodo doctor" "$(printf '%s' "$doc" | tail -3)" ;;
esac
case "$doc" in
  *sk-*) bad "doctor prints no credentials" "output contained an API-key-shaped string" ;;
  *) ok "kodo doctor prints no credentials" ;;
esac

# ── 5. init ──────────────────────────────────────────────────────────────────
init="$(cd "$PROJECT" && run_installed init --no-instructions || true)"
if [ -f "${PROJECT}/.kodo/settings.json" ]; then
  ok "kodo init creates project configuration"
else
  bad "kodo init" "$(printf '%s' "$init" | tail -3)"
fi

# ── 6. run, with no provider configured ──────────────────────────────────────
# Must fail FAST with the configuration/auth code, not hang or pretend success.
set +e
(cd "$PROJECT" && run_installed run "say hello" >"${WORK}/run.log" 2>&1)
rc=$?
set -e
if [ "$rc" -eq 3 ] || [ "$rc" -eq 4 ]; then
  ok "kodo run with no provider exits ${rc} (config/auth), not 0"
else
  bad "kodo run with no provider" "exit ${rc}; $(tail -2 "${WORK}/run.log")"
fi

# ── 7. UI, from outside the repository ───────────────────────────────────────
mv "$REPO" "$MOVED"
restore_repo() { [ -d "$MOVED" ] && mv "$MOVED" "$REPO" || true; }
trap 'restore_repo; cleanup' EXIT INT TERM

set +e
uistart="$(cd "$PROJECT" && env -i HOME="$HOME_DIR" PATH="${PREFIX}:/usr/bin:/bin" TERM=dumb NO_COLOR=1 \
  "${PREFIX}/kodo" ui start --port 0 --api-port 0 --detach 2>&1)"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  ok "kodo ui start works with the source repository MOVED AWAY"
  case "$uistart" in
    *"Falling back to the built-in"*) bad "the bundled production UI is used" "it fell back to the built-in page" ;;
    *) ok "the bundled production Next.js UI is used" ;;
  esac

  uiport="$(node -p "require('${HOME_DIR}/.kodo/runtime/ui.json').port" 2>/dev/null || echo "")"
  if [ -n "$uiport" ] && curl -fsS -o /dev/null "http://127.0.0.1:${uiport}/"; then
    ok "the UI answers on http://127.0.0.1:${uiport}"
  else
    bad "the UI answers" "no response on port '${uiport}'"
  fi

  status="$(cd / && env -i HOME="$HOME_DIR" PATH="${PREFIX}:/usr/bin:/bin" NO_COLOR=1 "${PREFIX}/kodo" ui status 2>&1)"
  case "$status" in *running*) ok "kodo ui status reports running" ;; *) bad "kodo ui status" "$status" ;; esac

  stop="$(cd / && env -i HOME="$HOME_DIR" PATH="${PREFIX}:/usr/bin:/bin" NO_COLOR=1 "${PREFIX}/kodo" ui stop 2>&1)"
  case "$stop" in *stopped*) ok "kodo ui stop stops it" ;; *) bad "kodo ui stop" "$stop" ;; esac
  env -i HOME="$HOME_DIR" PATH="${PREFIX}:/usr/bin:/bin" NO_COLOR=1 "${PREFIX}/kodo" server stop >/dev/null 2>&1 || true
else
  bad "kodo ui start with the repository moved away" "$(printf '%s' "$uistart" | tail -4)"
fi

restore_repo
trap 'cleanup' EXIT INT TERM

# ── 8. upgrade over an existing install ──────────────────────────────────────
mkdir -p "${HOME_DIR}/.kodo"
printf '{"model":"survivor"}' > "${HOME_DIR}/.kodo/config.json"
if env KODO_BASE_URL="$BASE" KODO_INSTALL_DIR="$PREFIX" HOME="$HOME_DIR" \
     sh "${REPO}/install.sh" >/dev/null 2>&1; then
  grep -q survivor "${HOME_DIR}/.kodo/config.json" \
    && ok "upgrading over an existing install preserves ~/.kodo" \
    || bad "upgrade preserves ~/.kodo" "configuration was modified"
else
  bad "upgrade over an existing install" "reinstall failed"
fi

# ── 9. uninstall ─────────────────────────────────────────────────────────────
set +e
printf 'y\n' | env HOME="$HOME_DIR" PATH="${PREFIX}:$PATH" "${PREFIX}/kodo" uninstall >"${WORK}/uninstall.log" 2>&1
set -e
if [ -x "${PREFIX}/kodo" ]; then
  bad "kodo uninstall removes the launcher" "$(tail -3 "${WORK}/uninstall.log")"
else
  ok "kodo uninstall removes the launcher"
fi
[ -d "$PROJECT" ] && ok "uninstall left the project directory alone" \
                  || bad "uninstall left the project alone" "the project directory is gone"

printf '\n%s passed, %s failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
