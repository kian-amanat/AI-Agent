#!/bin/sh
# Kodo installer.
#
#   sh install.sh                      install from a source checkout (works today)
#   KODO_BASE_URL=... sh install.sh    install from a release host
#
# Design notes, because "pipe a script from the internet into a shell" deserves
# some care:
#
#   * POSIX sh, not bash — it has to run on Alpine, Debian minimal and macOS
#     without assuming which shell is installed.
#   * `set -eu` plus a main() that is only invoked on the LAST line. A truncated
#     download (connection dropped mid-transfer) therefore does nothing at all,
#     instead of executing half an installer.
#   * Every download is checksum-verified against the published SHA256SUMS
#     before anything is put on your PATH. --skip-checksum exists for local
#     testing and prints a warning.
#   * Installs to a user-writable directory. No sudo, ever — an installer that
#     asks for root to drop a binary in your home directory is asking for more
#     than it needs.
#   * Never touches ~/.kodo. Upgrades preserve configuration by construction.
#
# Options (environment variables):
#   KODO_VERSION       version to install (default: latest)
#   KODO_INSTALL_DIR   where to put the launcher (default: ~/.local/bin)
#   KODO_BASE_URL      release host. NO DEFAULT — see below.
#   KODO_SOURCE_DIR    source checkout to install from (default: this script'"'"'s directory)
#
# ── On release hosting ───────────────────────────────────────────────────────
#
# There is no published Kodo release host yet, so KODO_BASE_URL has no default.
# Pointing it at a plausible-looking URL that serves nothing would be worse than
# useless: `curl … | sh` would fail with a 404 halfway through, and the docs
# would be describing an artifact that does not exist.
#
# So this installer has two modes:
#
#   SOURCE (default)   Install from a checkout. Real, works today, and is what
#                      the documentation tells people to use.
#   RELEASE            Download + checksum-verify a published tarball. Fully
#                      implemented, and activated by setting KODO_BASE_URL once
#                      releases are actually published.

set -eu

KODO_BASE_URL="${KODO_BASE_URL:-}"
KODO_INSTALL_DIR="${KODO_INSTALL_DIR:-$HOME/.local/bin}"
KODO_VERSION="${KODO_VERSION:-latest}"
SKIP_CHECKSUM="${KODO_SKIP_CHECKSUM:-0}"

BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"; RESET="$(printf '\033[0m')"
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
die()  { printf '%serror%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."
}

detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows is not supported by this script. Use the PowerShell installer: ${KODO_BASE_URL}/install.ps1" ;;
    *) die "Unsupported operating system: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  PLATFORM="${OS}-${ARCH}"
}

# Kodo runs on Node. Check for it before downloading anything, so a machine that
# cannot run Kodo is told immediately rather than after a 40MB transfer.
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js 20.12 or newer is required and was not found.
  Install it from https://nodejs.org, or with your package manager, then re-run this installer."
  fi
  node_version="$(node --version | sed 's/^v//')"
  node_major="$(printf '%s' "$node_version" | cut -d. -f1)"
  node_minor="$(printf '%s' "$node_version" | cut -d. -f2)"
  if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 12 ]; }; then
    die "Node.js 20.12 or newer is required — found v${node_version}."
  fi
  step "Node.js v${node_version}"
}

resolve_version() {
  if [ "$KODO_VERSION" = "latest" ]; then
    KODO_VERSION="$(curl -fsSL "${KODO_BASE_URL}/releases/latest.txt" 2>/dev/null | tr -d '\r\n' || true)"
    [ -n "$KODO_VERSION" ] || die "Could not determine the latest Kodo version from ${KODO_BASE_URL}."
  fi
}

# ── Source install ───────────────────────────────────────────────────────────
# Installs a launcher that runs the CLI out of a checkout. No compilation step:
# Kodo is a Node application, so "installing" it means putting an executable on
# PATH that points Node at the right entry file.

source_dir() {
  if [ -n "${KODO_SOURCE_DIR:-}" ]; then printf '%s' "$KODO_SOURCE_DIR"; return; fi
  # The directory containing this script.
  d="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || d=""
  printf '%s' "$d"
}

install_from_source() {
  src="$(source_dir)"
  [ -n "$src" ] || die "Could not determine the source directory. Set KODO_SOURCE_DIR."

  if [ ! -f "${src}/cli/bin/kodo.mjs" ]; then
    die "No Kodo checkout at ${src} (expected cli/bin/kodo.mjs).
  Run this script from a Kodo checkout, or set KODO_SOURCE_DIR to one."
  fi

  if [ ! -d "${src}/backend1/node_modules" ]; then
    die "Kodo Core dependencies are not installed.
  Run:  npm --prefix ${src}/backend1 install"
  fi

  version="$(node -p "require('${src}/cli/package.json').version" 2>/dev/null || echo 0.0.0)"
  step "Kodo ${version} from ${src}"

  mkdir -p "$KODO_INSTALL_DIR" || die "Could not create ${KODO_INSTALL_DIR}."
  if [ ! -w "$KODO_INSTALL_DIR" ]; then
    die "${KODO_INSTALL_DIR} is not writable.
  Set KODO_INSTALL_DIR to a directory you own, for example:
    KODO_INSTALL_DIR=\$HOME/bin sh install.sh"
  fi

  # Written to a temp name and renamed: an interrupted install leaves the
  # previous launcher intact rather than a half-written file on your PATH.
  launcher="${KODO_INSTALL_DIR}/kodo"
  {
    echo '#!/bin/sh'
    echo '# Kodo launcher (source install) — generated by install.sh.'
    echo '# Update Kodo by updating the checkout below; see `kodo update`.'
    echo "KODO_SOURCE_DIR=\"${src}\""
    echo 'export KODO_SOURCE_DIR'
    echo "KODO_NODE=\"$(command -v node)\""
    echo '[ -x "$KODO_NODE" ] || KODO_NODE="$(command -v node 2>/dev/null)"'
    echo '[ -n "$KODO_NODE" ] || { echo "kodo: Node.js not found. Install Node 20.12+ and retry." >&2; exit 3; }'
    echo "exec \"\$KODO_NODE\" \"${src}/cli/bin/kodo.mjs\" \"\$@\""
  } > "${launcher}.new"
  chmod +x "${launcher}.new"
  mv -f "${launcher}.new" "$launcher"
  step "Installed kodo to ${launcher}"
}

verify_checksum() {
  archive="$1"
  sums="$2"
  name="$(basename "$archive")"

  if [ "$SKIP_CHECKSUM" = "1" ]; then
    printf '%s!%s skipping checksum verification (KODO_SKIP_CHECKSUM=1)\n' "$RED" "$RESET" >&2
    return 0
  fi

  expected="$(grep " $name\$" "$sums" 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$expected" ] || die "No checksum published for ${name}. Refusing to install an unverified download."

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  else
    die "Neither sha256sum nor shasum is available, so the download cannot be verified."
  fi

  [ "$expected" = "$actual" ] || die "Checksum mismatch for ${name}.
  expected: ${expected}
  actual:   ${actual}
  The download was corrupted or tampered with. Nothing was installed."

  step "Verified checksum"
}

path_hint() {
  case ":${PATH}:" in
    *":${KODO_INSTALL_DIR}:"*) return 0 ;;
  esac

  say ""
  say "${BOLD}${KODO_INSTALL_DIR} is not on your PATH.${RESET}"
  say "Add it by running one of these, then restart your shell:"
  say ""
  say "  ${DIM}# bash${RESET}"
  say "  echo 'export PATH=\"${KODO_INSTALL_DIR}:\$PATH\"' >> ~/.bashrc"
  say ""
  say "  ${DIM}# zsh${RESET}"
  say "  echo 'export PATH=\"${KODO_INSTALL_DIR}:\$PATH\"' >> ~/.zshrc"
  say ""
  say "  ${DIM}# fish${RESET}"
  say "  fish_add_path ${KODO_INSTALL_DIR}"
}

main() {
  need mkdir

  say ""
  say "${BOLD}Installing Kodo...${RESET}"
  say ""

  detect_platform
  step "Detected ${OS} ${ARCH}"
  check_node

  # No release host configured → install from source. This is the supported
  # path today, and it is a real install, not a fallback stub.
  if [ -z "$KODO_BASE_URL" ]; then
    install_from_source
    say ""
    say "Run:"
    say ""
    say "  ${BOLD}kodo${RESET}"
    say ""
    say "Documentation:  ${DIM}docs/installation.md${RESET}"
    path_hint
    say ""
    return 0
  fi

  need curl
  need tar
  resolve_version

  tmp="$(mktemp -d)"
  # Clean up on every exit path, including failure and Ctrl+C.
  trap 'rm -rf "$tmp"' EXIT INT TERM

  archive_name="kodo-${KODO_VERSION}-${PLATFORM}.tar.gz"
  archive_url="${KODO_BASE_URL}/releases/${KODO_VERSION}/${archive_name}"
  sums_url="${KODO_BASE_URL}/releases/${KODO_VERSION}/SHA256SUMS"

  curl -fsSL "$archive_url" -o "${tmp}/${archive_name}" \
    || die "Download failed: ${archive_url}"
  step "Downloaded Kodo ${KODO_VERSION}"

  if [ "$SKIP_CHECKSUM" != "1" ]; then
    curl -fsSL "$sums_url" -o "${tmp}/SHA256SUMS" \
      || die "Could not fetch checksums from ${sums_url}. Refusing to install unverified."
  fi
  verify_checksum "${tmp}/${archive_name}" "${tmp}/SHA256SUMS"

  # Refuse a hostile archive BEFORE extracting it.
  #
  # A tarball is attacker-controlled input the moment a release host is
  # compromised or a download is intercepted, and the checksum only proves the
  # bytes match what the host served. `../` entries, absolute paths and symlinks
  # pointing outside the extraction directory can all overwrite files the user
  # never agreed to touch. tar implementations differ in what they refuse, so
  # this does not rely on any of them: list the archive and reject on sight.
  listing="$(tar -tzf "${tmp}/${archive_name}" 2>/dev/null)" \
    || die "Could not read ${archive_name} — it is not a valid archive."

  bad_entries="$(printf '%s\n' "$listing" | grep -E '^/|(^|/)\.\.(/|$)' || true)"
  if [ -n "$bad_entries" ]; then
    die "Refusing to extract ${archive_name}: it contains paths that escape the extraction directory.
$(printf '%s\n' "$bad_entries" | head -5)"
  fi

  stray="$(printf '%s\n' "$listing" | grep -v '^kodo/\|^kodo$' || true)"
  if [ -n "$stray" ]; then
    die "Refusing to extract ${archive_name}: it writes outside kodo/.
$(printf '%s\n' "$stray" | head -5)"
  fi

  tar -xzf "${tmp}/${archive_name}" -C "$tmp" --no-same-owner \
    || die "Could not extract ${archive_name}."

  # Absolute symlinks are the remaining escape: a later entry can be written
  # THROUGH one, landing outside the payload entirely.
  escaped="$(find "${tmp}/kodo" -type l -exec readlink {} \; 2>/dev/null | grep '^/' || true)"
  if [ -n "$escaped" ]; then
    rm -rf "${tmp}/kodo"
    die "Refusing to install ${archive_name}: it contains absolute symlinks.
$(printf '%s\n' "$escaped" | head -5)"
  fi

  mkdir -p "$KODO_INSTALL_DIR" || die "Could not create ${KODO_INSTALL_DIR}."
  [ -w "$KODO_INSTALL_DIR" ] || die "${KODO_INSTALL_DIR} is not writable.
  Set KODO_INSTALL_DIR to a directory you own, e.g.:
    KODO_INSTALL_DIR=\"\$HOME/bin\" sh install.sh"

  # Install into a VERSIONED directory and repoint the launcher last. The swap
  # is then atomic: an interrupted upgrade leaves the previous version working
  # rather than a half-written install on your PATH. ~/.kodo is never touched,
  # so configuration survives by construction.
  lib_dir="${HOME}/.local/share/kodo"
  mkdir -p "$lib_dir"
  rm -rf "${lib_dir}/${KODO_VERSION}.partial"
  mv "${tmp}/kodo" "${lib_dir}/${KODO_VERSION}.partial"

  # Dependencies are already IN the artifact — see scripts/build-release.mjs.
  # A release that runs `npm install` on the user's machine is not installed,
  # it is half-downloaded: it needs a package manager, a working registry and a
  # few minutes, and it fails on an air-gapped or offline machine. This is why
  # the artifacts are per-platform: they carry a native module compiled for
  # exactly one platform and Node ABI.
  if [ ! -d "${lib_dir}/${KODO_VERSION}.partial/backend1/node_modules" ]; then
    rm -rf "${lib_dir}/${KODO_VERSION}.partial"
    die "This artifact is incomplete — it has no bundled dependencies.
  It was probably built with an older build script. Rebuild with:
    node scripts/build-release.mjs"
  fi

  rm -rf "${lib_dir}/${KODO_VERSION}"
  mv "${lib_dir}/${KODO_VERSION}.partial" "${lib_dir}/${KODO_VERSION}"

  # A launcher script, not a symlink to the entry file: the CLI locates Kodo
  # Core relative to its own path, and a symlink on PATH would resolve
  # differently depending on the shell. An explicit `exec node <abs path>` is
  # unambiguous everywhere.
  # The launcher pins the ABSOLUTE path of the Node that installed Kodo, and
  # falls back to PATH only if that Node later disappears.
  #
  # A bare `exec node` looked fine and broke the moment PATH differed from the
  # installing shell's — which is routine: nvm and asdf put Node on the PATH of
  # interactive shells only, so Kodo worked in a terminal and failed from a
  # service, a cron job, or any scrubbed environment. Recording the interpreter
  # we actually verified against removes the guesswork.
  node_bin="$(command -v node)"
  launcher="${KODO_INSTALL_DIR}/kodo"
  {
    echo '#!/bin/sh'
    echo "# Kodo launcher ${KODO_VERSION} (release install) — generated by install.sh"
    echo "KODO_NODE=\"${node_bin}\""
    echo '[ -x "$KODO_NODE" ] || KODO_NODE="$(command -v node 2>/dev/null)"'
    echo '[ -n "$KODO_NODE" ] || { echo "kodo: Node.js not found. Install Node 20.12+ and retry." >&2; exit 3; }'
    echo "exec \"\$KODO_NODE\" \"${lib_dir}/${KODO_VERSION}/cli/bin/kodo.mjs\" \"\$@\""
  } > "${launcher}.new"
  chmod +x "${launcher}.new"
  mv -f "${launcher}.new" "$launcher"
  step "Installed kodo ${KODO_VERSION}"

  say ""
  say "Run:"
  say ""
  say "  ${BOLD}kodo${RESET}"
  say ""
  say "Documentation:"
  say "  ${KODO_BASE_URL}/docs"

  path_hint
  say ""
}

# Only reached on a complete download — see the header.
main "$@"
