#!/bin/sh
# scripts/test-release.sh — exercise the RELEASE installer path end to end.
#
# There is no public Kodo release host, so this stands one up locally: build
# real artifacts, serve them over HTTP, and run the actual install.sh against
# them. That makes the release path verifiable today instead of theoretical.
#
# Scenarios covered:
#   1. fresh install from a release
#   2. the installed CLI actually runs
#   3. reinstall of the same version (idempotent)
#   4. CHECKSUM MISMATCH — must refuse and install nothing
#   5. missing artifact (404) — must refuse
#   6. unsupported architecture — must refuse
#   7. configuration in ~/.kodo survives an upgrade
#
# Everything happens in temp directories. Nothing touches your real install.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
SERVE="${WORK}/serve"
BIN="${WORK}/bin"
HOME_DIR="${WORK}/home"
PORT="${KODO_TEST_RELEASE_PORT:-8731}"
BASE="http://127.0.0.1:${PORT}"

pass=0
fail=0
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

ok()   { printf '  \033[32m✅\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m❌\033[0m %s\n' "$1"; printf '     %s\n' "${2:-}"; fail=$((fail+1)); }

printf '\n📦 release installer — end to end against a local release host\n\n'

VERSION="$(node -p "require('${REPO}/cli/package.json').version")"
PLATFORM="$(uname -s | tr 'A-Z' 'a-z')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/;s/arm64/arm64/')"

# ── Build + serve ────────────────────────────────────────────────────────────
node "${REPO}/scripts/build-release.mjs" --out "${WORK}/dist" --platform "$PLATFORM" >/dev/null 2>&1 \
  || { bad "build artifacts" "build-release.mjs failed"; exit 1; }
ok "built release artifacts for ${PLATFORM}"

mkdir -p "${SERVE}/releases/${VERSION}"
cp "${WORK}/dist/"*.tar.gz "${WORK}/dist/SHA256SUMS" "${SERVE}/releases/${VERSION}/"
cp "${WORK}/dist/latest.txt" "${SERVE}/releases/"

(cd "$SERVE" && exec python3 -m http.server "$PORT" >/dev/null 2>&1) &
SERVER_PID=$!

# Wait for it rather than sleeping a fixed amount.
i=0
while [ $i -lt 50 ]; do
  if curl -fsS "${BASE}/releases/latest.txt" >/dev/null 2>&1; then break; fi
  i=$((i+1)); sleep 0.1
done
[ $i -lt 50 ] || { bad "local release host" "did not come up on ${PORT}"; exit 1; }
ok "serving a local release host on ${BASE}"

install_release() {
  env KODO_BASE_URL="$BASE" KODO_INSTALL_DIR="$BIN" HOME="$HOME_DIR" \
      sh "${REPO}/install.sh" 2>&1
}

# ── 1. fresh install ─────────────────────────────────────────────────────────
mkdir -p "$HOME_DIR"
if out="$(install_release)"; then
  case "$out" in
    *"Verified checksum"*) ok "fresh install verified the checksum" ;;
    *) bad "fresh install verified the checksum" "installer did not report verification" ;;
  esac
  [ -x "${BIN}/kodo" ] && ok "installed an executable launcher" || bad "installed an executable launcher" "missing ${BIN}/kodo"
else
  bad "fresh install from a release" "$out"
fi

# ── 2. the installed CLI runs ────────────────────────────────────────────────
# From OUTSIDE the repository, so nothing works by accident of cwd.
if reported="$(cd / && "${BIN}/kodo" --version 2>&1)"; then
  [ "$reported" = "$VERSION" ] \
    && ok "installed CLI runs from outside the repo and reports ${VERSION}" \
    || bad "installed CLI reports the right version" "got '${reported}', wanted '${VERSION}'"
else
  bad "installed CLI runs" "$reported"
fi

# ── 3. reinstall same version ────────────────────────────────────────────────
if install_release >/dev/null 2>&1 && [ -x "${BIN}/kodo" ]; then
  ok "reinstalling the same version is idempotent"
else
  bad "reinstalling the same version" "second install broke the launcher"
fi

# ── 4. configuration survives ────────────────────────────────────────────────
mkdir -p "${HOME_DIR}/.kodo"
printf '{"model":"survivor","apiKey":"sk-must-survive-upgrade"}' > "${HOME_DIR}/.kodo/config.json"
install_release >/dev/null 2>&1
if grep -q "survivor" "${HOME_DIR}/.kodo/config.json" 2>/dev/null; then
  ok "~/.kodo configuration survives a reinstall"
else
  bad "~/.kodo configuration survives a reinstall" "config was modified or removed"
fi

# ── 5. CHECKSUM MISMATCH must refuse ─────────────────────────────────────────
# Corrupt the artifact but leave SHA256SUMS untouched — exactly what a tampered
# or truncated download looks like.
BEFORE="$(cat "${BIN}/kodo" 2>/dev/null | shasum -a 256 | awk '{print $1}')"
printf 'corrupted' >> "${SERVE}/releases/${VERSION}/kodo-${VERSION}-${PLATFORM}.tar.gz"
if out="$(install_release 2>&1)"; then
  bad "a corrupted artifact is refused" "the installer SUCCEEDED on a tampered download"
else
  case "$out" in
    *"Checksum mismatch"*) ok "a corrupted artifact is refused with a checksum error" ;;
    *) bad "a corrupted artifact is refused" "refused, but not for the checksum: ${out}" ;;
  esac
fi
AFTER="$(cat "${BIN}/kodo" 2>/dev/null | shasum -a 256 | awk '{print $1}')"
[ "$BEFORE" = "$AFTER" ] \
  && ok "the previous installation is untouched after a refused install" \
  || bad "the previous installation is untouched" "the launcher changed despite a failed install"

# Restore the good artifact.
cp "${WORK}/dist/kodo-${VERSION}-${PLATFORM}.tar.gz" "${SERVE}/releases/${VERSION}/"

# ── 6. missing artifact (404) ────────────────────────────────────────────────
if out="$(env KODO_BASE_URL="$BASE" KODO_INSTALL_DIR="$BIN" HOME="$HOME_DIR" KODO_VERSION="9.9.9" \
          sh "${REPO}/install.sh" 2>&1)"; then
  bad "a missing release is refused" "the installer succeeded for a version that does not exist"
else
  case "$out" in
    *"Download failed"*|*"Could not fetch checksums"*) ok "a missing release fails with a clear error" ;;
    *) bad "a missing release fails clearly" "$out" ;;
  esac
fi

# ── 7. unsupported architecture ──────────────────────────────────────────────
# The installer derives the platform from uname; a machine it has no build for
# must be told so rather than downloading something wrong.
if out="$(env KODO_BASE_URL="$BASE" KODO_INSTALL_DIR="$BIN" HOME="$HOME_DIR" \
          PATH="${WORK}/fakebin:$PATH" sh -c '
            mkdir -p '"${WORK}"'/fakebin
            printf "#!/bin/sh\ncase \"\$1\" in -s) echo Linux;; -m) echo mips64;; *) echo Linux;; esac\n" > '"${WORK}"'/fakebin/uname
            chmod +x '"${WORK}"'/fakebin/uname
            sh '"${REPO}"'/install.sh' 2>&1)"; then
  bad "an unsupported architecture is refused" "the installer proceeded on mips64"
else
  case "$out" in
    *"Unsupported architecture"*) ok "an unsupported architecture is refused by name" ;;
    *) bad "an unsupported architecture is refused" "$out" ;;
  esac
fi

# ── 8. MALICIOUS ARCHIVE must be refused ─────────────────────────────────────
# A checksum only proves the bytes match what the host served. If the host is
# compromised, the archive itself is attacker-controlled — so path traversal
# and absolute symlinks have to be refused independently.
EVIL="${WORK}/evil"
mkdir -p "${EVIL}/kodo/cli/bin"
printf 'pwned' > "${EVIL}/kodo/cli/bin/kodo.mjs"
mkdir -p "${EVIL}/outside"
printf 'should never be written' > "${EVIL}/outside/victim.txt"

# 8a. path traversal
(cd "$EVIL" && tar -czf "${WORK}/traversal.tar.gz" kodo ../$(basename "$EVIL")/outside 2>/dev/null) ||   (cd "$EVIL" && tar -czf "${WORK}/traversal.tar.gz" kodo 2>/dev/null &&    tar -czf "${WORK}/traversal.tar.gz" -C "$EVIL" kodo --transform 's|^kodo|../escaped|' 2>/dev/null) || true

python3 - "$WORK" <<'PYEOF'
import sys, tarfile, io, os
work = sys.argv[1]
# Build a tarball containing an explicit ../ entry — portable across tar flavours.
p = os.path.join(work, "traversal.tar.gz")
with tarfile.open(p, "w:gz") as tf:
    data = b"pwned"
    for name in ("kodo/cli/bin/kodo.mjs", "../escaped.txt"):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
PYEOF

cp "${WORK}/traversal.tar.gz" "${SERVE}/releases/${VERSION}/kodo-${VERSION}-${PLATFORM}.tar.gz"
(cd "${SERVE}/releases/${VERSION}" &&   { command -v sha256sum >/dev/null && sha256sum "kodo-${VERSION}-${PLATFORM}.tar.gz" > SHA256SUMS; } ||   shasum -a 256 "kodo-${VERSION}-${PLATFORM}.tar.gz" > SHA256SUMS)

if out="$(install_release 2>&1)"; then
  bad "a path-traversal archive is refused" "the installer EXTRACTED an archive containing ../"
else
  case "$out" in
    *"escape the extraction directory"*|*"writes outside kodo"*) ok "a path-traversal archive is refused" ;;
    *) bad "a path-traversal archive is refused" "refused, but not for traversal: $(printf '%s' "$out" | tail -2)" ;;
  esac
fi
[ -f "${WORK}/escaped.txt" ] && bad "traversal wrote outside" "escaped.txt was created" || ok "nothing was written outside the extraction directory"

# 8b. absolute symlink
python3 - "$WORK" <<'PYEOF'
import sys, tarfile, io, os
work = sys.argv[1]
p = os.path.join(work, "symlink.tar.gz")
with tarfile.open(p, "w:gz") as tf:
    data = b"ok"
    info = tarfile.TarInfo("kodo/cli/bin/kodo.mjs"); info.size = len(data)
    tf.addfile(info, io.BytesIO(data))
    link = tarfile.TarInfo("kodo/evil-link")
    link.type = tarfile.SYMTYPE
    link.linkname = "/etc/passwd"
    tf.addfile(link)
PYEOF
cp "${WORK}/symlink.tar.gz" "${SERVE}/releases/${VERSION}/kodo-${VERSION}-${PLATFORM}.tar.gz"
(cd "${SERVE}/releases/${VERSION}" &&   { command -v sha256sum >/dev/null && sha256sum "kodo-${VERSION}-${PLATFORM}.tar.gz" > SHA256SUMS; } ||   shasum -a 256 "kodo-${VERSION}-${PLATFORM}.tar.gz" > SHA256SUMS)

if out="$(install_release 2>&1)"; then
  bad "an absolute-symlink archive is refused" "the installer accepted it"
else
  case "$out" in
    *"absolute symlinks"*) ok "an absolute-symlink archive is refused" ;;
    *) bad "an absolute-symlink archive is refused" "refused for another reason: $(printf '%s' "$out" | tail -2)" ;;
  esac
fi

# Restore the genuine artifact + checksums for the final check.
cp "${WORK}/dist/kodo-${VERSION}-${PLATFORM}.tar.gz" "${SERVE}/releases/${VERSION}/"
cp "${WORK}/dist/SHA256SUMS" "${SERVE}/releases/${VERSION}/"

# ── 9. no secrets in installer output ────────────────────────────────────────
out="$(install_release 2>&1)"
case "$out" in
  *sk-*) bad "installer output contains no credentials" "output contained an API-key-shaped string" ;;
  *) ok "installer output contains no credentials" ;;
esac

printf '\n%s passed, %s failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
