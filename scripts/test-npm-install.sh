#!/bin/sh
# scripts/test-npm-install.sh — the test that defines success for npm distribution.
#
#     npm install -g kodo-agent   →   kodo
#
# It builds the package, packs it, installs the TARBALL into an isolated npm
# prefix, and then drives the installed `kodo` from an unrelated directory with
# the repository unreachable.
#
# The isolation matters. Every layout bug in a Node CLI looks identical from
# inside the repo — relative paths resolve, node_modules is a parent away, and
# everything passes. The first one here was `require("../package.json")`, which
# is cli/package.json in the checkout and the package ROOT once installed:
# `kodo --version` crashed with MODULE_NOT_FOUND on a globally installed Kodo.
# Nothing short of installing the real artifact catches that class of bug.
#
# Uses --prefix, so your real global npm install is never touched.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PREFIX="${WORK}/npm-global"
HOME_DIR="${WORK}/home"
PROJECT="${WORK}/user-project"
PKG_NAME="${KODO_NPM_NAME:-kodo-agent}"

pass=0; fail=0
UI_PORTS=""
MOVED=""

cleanup() {
  [ -n "$MOVED" ] && [ -d "$MOVED" ] && mv "$MOVED" "$REPO" 2>/dev/null || true
  if [ -x "${PREFIX}/bin/kodo" ]; then
    HOME="$HOME_DIR" "${PREFIX}/bin/kodo" ui stop >/dev/null 2>&1 || true
    HOME="$HOME_DIR" "${PREFIX}/bin/kodo" server stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

ok()  { printf '  \033[32m✅\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1"; printf '     %s\n' "${2:-}"; fail=$((fail+1)); }

printf '\n📦 npm install -g — the primary installation path\n\n'

VERSION="$(node -p "require('${REPO}/cli/package.json').version")"

# ── Build + pack ─────────────────────────────────────────────────────────────
if node "${REPO}/scripts/build-npm-package.mjs" >"${WORK}/build.log" 2>&1; then
  ok "built the package (staged)"
else
  bad "build the package" "$(tail -5 "${WORK}/build.log")"; exit 1
fi

TARBALL="${WORK}/${PKG_NAME}-${VERSION}.tgz"
if (cd "${REPO}/dist-npm" && npm pack --pack-destination "$WORK" >/dev/null 2>&1) && [ -f "$TARBALL" ]; then
  size="$(du -h "$TARBALL" | awk '{print $1}')"
  ok "npm pack produced ${PKG_NAME}-${VERSION}.tgz (${size})"
else
  bad "npm pack" "no tarball at $TARBALL"; exit 1
fi

# ── Package content audit ────────────────────────────────────────────────────
entries="$(tar -tzf "$TARBALL")"
missing=""
for required in \
  package/package.json \
  package/cli/bin/kodo.mjs \
  package/cli/src/main.mjs \
  package/backend1/core/index.mjs \
  package/backend1/server.mjs \
  package/ui/.next/BUILD_ID
do
  printf '%s\n' "$entries" | grep -qx "$required" || missing="${missing} ${required}"
done
[ -z "$missing" ] && ok "the tarball contains every required runtime file" \
                  || bad "required files missing from the tarball" "$missing"

# A real node_modules DIRECTORY must not ship. Next.js names compiled chunks
# `node_modules_*.js`, so match a path SEGMENT rather than a substring.
if printf '%s\n' "$entries" | grep -qE '(^|/)node_modules/'; then
  bad "no node_modules directory is published" "found one in the tarball"
else
  ok "no node_modules directory is published (npm resolves dependencies)"
fi

for pattern in '\.env$' '/tests/' '\.test\.mjs$' '(^|/)\.git/'; do
  if printf '%s\n' "$entries" | grep -qE "$pattern"; then
    bad "the tarball excludes ${pattern}" "found matching entries"
  fi
done
ok "the tarball excludes secrets, tests and repository metadata"

# ── Privacy: never ship the developer's own workspace state ──────────────────
#
# 2.0.0-rc.1 was published from the monorepo ROOT and carried .kodo/memory/ to
# the public registry — project notes and personal information that were never
# meant to leave the machine. The builder excludes .kodo, but nothing ASSERTED
# it, so the exclusion could regress silently and be noticed only after another
# publish. It cannot be un-published from someone else's cache.
privacy_hits=""
for pattern in '(^|/)\.kodo/' '(^|/)\.kodo$' 'memory\.db$' '\.sqlite$' '(^|/)\.claude/' '(^|/)\.npmrc$' '(^|/)\.ssh/'; do
  hit="$(printf '%s\n' "$entries" | grep -E "$pattern" | head -3 || true)"
  [ -n "$hit" ] && privacy_hits="${privacy_hits} ${hit}"
done
if [ -n "$privacy_hits" ]; then
  bad "the tarball ships no personal workspace data" "found:${privacy_hits}"
else
  ok "the tarball ships no personal workspace data (.kodo, databases, credentials)"
fi

if node -e "
  const p = require('${REPO}/dist-npm/package.json');
  const bad = Object.keys(p.scripts || {});
  if (bad.length) { console.error(bad.join(',')); process.exit(1); }
  if (!p.bin || p.bin.kodo !== 'cli/bin/kodo.mjs') { console.error('bin'); process.exit(1); }
  if (!p.engines || !p.engines.node) { console.error('engines'); process.exit(1); }
" 2>/dev/null; then
  ok "manifest declares bin + engines and NO lifecycle scripts"
else
  bad "manifest" "lifecycle scripts present, or bin/engines missing"
fi

# ── Global install ───────────────────────────────────────────────────────────
mkdir -p "$PREFIX" "$HOME_DIR" "$PROJECT"
printf '  … npm install -g (resolves dependencies; takes a minute)\n'
if npm install -g --prefix "$PREFIX" "$TARBALL" >"${WORK}/install.log" 2>&1; then
  ok "npm install -g succeeded"
else
  bad "npm install -g" "$(tail -6 "${WORK}/install.log")"; exit 1
fi

[ -e "${PREFIX}/bin/kodo" ] && ok "the \`kodo\` command was linked onto PATH" \
                           || bad "the \`kodo\` command was linked" "no ${PREFIX}/bin/kodo"

# The native dependency must actually load, not merely download.
if node -e "require('${PREFIX}/lib/node_modules/${PKG_NAME}/../better-sqlite3')" 2>/dev/null \
   || node --input-type=module -e "
     const { createRequire } = await import('module');
     const r = createRequire('${PREFIX}/lib/node_modules/${PKG_NAME}/package.json');
     r('better-sqlite3');
   " 2>/dev/null; then
  ok "the native dependency (better-sqlite3) loads on this platform"
else
  bad "the native dependency loads" "better-sqlite3 did not load after install"
fi

# ── Drive the installed CLI with the repository MOVED AWAY ───────────────────
MOVED="${WORK}/repo-moved-away"
mv "$REPO" "$MOVED"

# A realistic user PATH, not a minimal one.
#
# npm's bin shim is `#!/usr/bin/env node`, so `node` must be on PATH — that is
# npm's contract for every Node CLI, and anyone who ran `npm install` has it.
# /usr/local/bin and /opt/homebrew/bin are where docker and other user tools
# live on macOS.
#
# The REPOSITORY stays unreachable, which is the thing this test isolates.
# Stripping ordinary system directories as well only tests an environment no
# user has.
NODE_BIN_DIR="$(dirname "$(command -v node)")"

kodo_run() {
  env -i HOME="$HOME_DIR" \
      PATH="${PREFIX}/bin:${NODE_BIN_DIR}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM=dumb NO_COLOR=1 kodo "$@" 2>&1
}

# ── Self-containment: the package must carry its own runtime deps ────────────
#
# Regression test for 2.0.0-rc.1, which installed cleanly and then failed on
# first real use with "Cannot find package '@langchain/core'". Every check
# above still passed on that build, because `--version`, `--help` and `doctor`
# only load the CLI — none of them touch the agent, the API or the database.
#
# So load what those commands never do. Both halves matter:
#   (a) every DECLARED dependency resolves from the installed package
#   (b) every production entry point actually IMPORTS
# (a) alone would miss an incomplete dependency list; (b) alone would miss a
# dependency reachable only on a code path this harness does not execute.
INSTALLED="${PREFIX}/lib/node_modules/${PKG_NAME}"

unresolved="$(node --input-type=module -e "
  const { createRequire } = await import('module');
  const fs = await import('fs');
  const manifest = JSON.parse(fs.readFileSync('${INSTALLED}/package.json', 'utf-8'));
  const require_ = createRequire('${INSTALLED}/package.json');
  const missing = [];
  for (const dep of Object.keys(manifest.dependencies || {})) {
    try { require_.resolve(dep); } catch { missing.push(dep); }
  }
  if (!Object.keys(manifest.dependencies || {}).length) missing.push('(manifest declares NO dependencies)');
  console.log(missing.join(' '));
" 2>&1 || echo "probe failed")"
[ -z "$unresolved" ] && ok "every declared dependency resolves from the installed package" \
                     || bad "declared dependencies resolve" "missing: ${unresolved}"

# The production modules a user reaches the moment they do anything real.
# Between them these pull @langchain/core, @langchain/langgraph, openai,
# better-sqlite3, undici, bcryptjs, jsonwebtoken and pdf-parse.
entry_fail=""
for entry in \
  backend1/core/index.mjs \
  backend1/agents/kodo_graph.mjs \
  backend1/agents/nodes/agent_loop.mjs \
  backend1/services/mcpTools.mjs \
  backend1/services/agentChat.mjs \
  backend1/services/attachments.service.mjs \
  backend1/routes/auth.mjs \
  backend1/db.mjs \
  cli/src/main.mjs
do
  if ! err="$(cd /tmp && env -i HOME="$HOME_DIR" PATH="${NODE_BIN_DIR}:/usr/bin:/bin" \
      node --input-type=module -e "await import('${INSTALLED}/${entry}')" 2>&1)"; then
    entry_fail="${entry_fail}
     ${entry}: $(printf '%s' "$err" | grep -m1 -E "Cannot find|Error" | cut -c1-100)"
  fi
done
[ -z "$entry_fail" ] && ok "every production entry point imports from the installed package" \
                     || bad "production entry points import" "$entry_fail"

reported="$(cd /tmp && kodo_run --version || true)"
[ "$reported" = "$VERSION" ] \
  && ok "kodo --version works from /tmp with the repository gone" \
  || bad "kodo --version" "got '${reported}', wanted '${VERSION}'"

help="$(cd /tmp && kodo_run --help || true)"
case "$help" in *"AI coding agent"*) ok "kodo --help works" ;; *) bad "kodo --help" "$(printf '%s' "$help" | head -3)" ;; esac

doc="$(cd /tmp && kodo_run doctor || true)"
case "$doc" in *"Kodo CLI"*) ok "kodo doctor works" ;; *) bad "kodo doctor" "$(printf '%s' "$doc" | tail -3)" ;; esac
case "$doc" in *sk-*) bad "doctor leaks no credentials" "key-shaped string in output" ;; *) ok "kodo doctor leaks no credentials" ;; esac

st="$(cd "$PROJECT" && kodo_run status || true)"
case "$st" in *Version*) ok "kodo status works" ;; *) bad "kodo status" "$(printf '%s' "$st" | tail -3)" ;; esac

(cd "$PROJECT" && kodo_run init --no-instructions >/dev/null 2>&1 || true)
[ -f "${PROJECT}/.kodo/settings.json" ] && ok "kodo init works in a user project" \
                                        || bad "kodo init" "no .kodo/settings.json"

sess="$(cd "$PROJECT" && kodo_run sessions || true)"
case "$sess" in *[Nn]o\ sessions*|*ID*) ok "kodo sessions works" ;; *) bad "kodo sessions" "$sess" ;; esac

# Unconfigured `run` must fail fast with the config/auth code — never 0.
set +e
(cd "$PROJECT" && kodo_run run "say hello" >"${WORK}/run.log" 2>&1)
rc=$?
set -e
{ [ "$rc" -eq 3 ] || [ "$rc" -eq 4 ]; } \
  && ok "kodo run without a provider exits ${rc} (config/auth), not 0" \
  || bad "kodo run without a provider" "exit ${rc}: $(tail -2 "${WORK}/run.log")"

# ── The web UI, from the installed package ───────────────────────────────────
set +e
uistart="$(cd "$PROJECT" && kodo_run ui start --port 0 --api-port 0 --detach)"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  ok "kodo ui start works from an installed package"
  case "$uistart" in
    *"Falling back to the built-in"*) bad "the production Next.js UI is served" "fell back to the built-in page" ;;
    *) ok "the production Next.js UI is served" ;;
  esac

  uiport="$(node -p "require('${HOME_DIR}/.kodo/runtime/ui.json').port" 2>/dev/null || echo "")"
  if [ -n "$uiport" ] && curl -fsS -o /dev/null --max-time 20 "http://127.0.0.1:${uiport}/"; then
    ok "the UI answers on http://127.0.0.1:${uiport}"
  else
    bad "the UI answers" "no response on port '${uiport}'"
  fi

  # The UI must run as the shape it was packaged as.
  #
  # The package ships an ordinary production build and starts it with `next
  # start`. It used to also ship the SOURCE next.config.ts, which declares
  # `output: "standalone"` — the release-tarball shape — so Next warned on every
  # start that `next start` was the wrong entry point for that config. The
  # config was genuinely wrong for this artifact; it is now generated to match.
  uilog="${HOME_DIR}/.kodo/logs/ui.log"
  if [ -f "$uilog" ] && grep -q 'does not work with "output: standalone"' "$uilog"; then
    bad "the UI starts without a configuration warning" \
        "next start was run against an output:standalone config"
  else
    ok "the UI starts with no Next.js configuration warning"
  fi

  # ── The workspace, from the installed package ──────────────────────────────
  #
  # Regression test for the bug where a CLI-first install could not chat at
  # all: `kodo ui start` worked, and the first message came back with "No
  # project connected yet. Open Kodo from your project (via the extension)".
  # The workspace was only ever bound by a client that already knew the path —
  # the VS Code extension — so an npm user had no way to connect a project.
  #
  # This asks the API a browser talks to, over HTTP, with a session created the
  # way the UI creates one: signup with NO workspacePath.
  apiport="$(node -p "require('${HOME_DIR}/.kodo/runtime/server.json').port" 2>/dev/null || echo "")"
  if [ -n "$apiport" ]; then
    api="http://127.0.0.1:${apiport}"
    tok="$(curl -fsS --max-time 20 -X POST "${api}/api/auth/signup" \
            -H 'Content-Type: application/json' \
            -d '{"email":"npm-test@example.test","password":"secret123","name":"NPM Test"}' \
          | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).token||''}catch{''}" 2>/dev/null || echo "")"
    if [ -n "$tok" ]; then
      wsbody="$(curl -fsS --max-time 20 "${api}/api/workspace" -H "Authorization: Bearer ${tok}" || echo "")"
      wspath="$(printf '%s' "$wsbody" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).workspace||''}catch{''}" 2>/dev/null || echo "")"
      # Compare CANONICAL paths. On macOS /var is a symlink to /private/var,
      # and Node's process.cwd() resolves it while the shell variable does not —
      # the same directory under two spellings is not a mismatch.
      canon_project="$(cd "$PROJECT" && pwd -P)"
      canon_ws="$(cd "$wspath" 2>/dev/null && pwd -P || echo "$wspath")"
      if [ "$canon_ws" = "$canon_project" ]; then
        ok "the installed CLI connects the workspace it was started in"
      else
        bad "the workspace is connected" "API reported '${canon_ws}', expected '${canon_project}'"
      fi

      # The exact user-visible symptom, against the endpoint the composer posts to.
      runbody="$(curl -fsS --max-time 60 -X POST "${api}/api/agent/run" \
                  -H 'Content-Type: application/json' -H "Authorization: Bearer ${tok}" \
                  -d '{"message":"hi"}' 2>&1 || true)"
      case "$runbody" in
        *no_workspace*|*"No project connected yet"*)
          bad "chatting does not demand a project connection" "$(printf '%s' "$runbody" | head -c 200)" ;;
        *)
          ok "sending a message does NOT answer 'No project connected yet'" ;;
      esac

      # An unauthenticated caller on the loopback port must get nothing.
      anon="$(curl -fsS --max-time 15 "${api}/api/workspace" || echo "")"
      case "$anon" in
        *"\"ok\":false"*) ok "an unauthenticated caller gets no workspace" ;;
        *) bad "unauthenticated workspace access is refused" "$(printf '%s' "$anon" | head -c 200)" ;;
      esac

      # ── The REAL browser handoff ────────────────────────────────────────────
      #
      # Everything above authenticates with a session this SCRIPT created via
      # signup. A user never does that: they open the URL `kodo ui start`
      # printed and the browser uses the token in its fragment. Those were
      # different credentials, and only the script's one was ever exercised —
      # so this suite passed while a freshly installed Kodo opened on a sign-in
      # wall and 401'd every authenticated call, because the CLI was handing the
      # browser the UI service's lifecycle token, which the API has never heard
      # of. Assert against the token users are actually given.
      urltok="$(printf '%s' "$uistart" | sed -n 's/.*#token=\([A-Za-z0-9._-]*\).*/\1/p' | head -1)"
      if [ -z "$urltok" ]; then
        bad "kodo ui start prints a browser session token" "no #token= in the printed URL"
      else
        capcode="$(curl -o /dev/null -s -w '%{http_code}' --max-time 20 "${api}/api/settings/capabilities" -H "Authorization: Bearer ${urltok}" || echo "000")"
        case "$capcode" in
          200) ok "the printed URL token authenticates against the API" ;;
          *)   bad "the printed URL token authenticates against the API" "/api/settings/capabilities returned ${capcode}" ;;
        esac

        urlws="$(curl -fsS --max-time 20 "${api}/api/workspace" -H "Authorization: Bearer ${urltok}" || echo "")"
        case "$urlws" in
          *no_workspace*|*"No project connected yet"*)
            bad "the printed URL token resolves the CLI workspace" "$(printf '%s' "$urlws" | head -c 200)" ;;
          *)
            urlwspath="$(printf '%s' "$urlws" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).workspace||''}catch{''}" 2>/dev/null || echo "")"
            canon_urlws="$(cd "$urlwspath" 2>/dev/null && pwd -P || echo "$urlwspath")"
            if [ "$canon_urlws" = "$canon_project" ]; then
              ok "the printed URL token resolves the workspace kodo ui start ran in"
            else
              bad "the printed URL token resolves the workspace kodo ui start ran in" "API reported '${canon_urlws}'"
            fi ;;
        esac
      fi

      # ── The BARE UI url (no ?kodoApi=, no #token=) ─────────────────────────
      #
      # Flow A is the generated URL, covered above. Flow B is a user who just
      # opens http://127.0.0.1:<uiport> and signs up. That flow reads the API
      # origin from the value the UI injects into the page — and that value was
      # PRERENDERED at build time, when KODO_API_ORIGIN is unset, freezing the
      # "http://localhost:9000" fallback into the HTML. Whenever the API is not
      # on 9000 (it picks a free port whenever 9000 is busy, and this suite
      # always uses --api-port 0), the browser POSTed signup into the void:
      # "Failed to fetch". The generated URL masked it by overriding the origin.
      #
      # Assert the page a bare visitor loads points at the API that is actually
      # running, then complete a real signup against it.
      if [ -n "$uiport" ]; then
        page="$(curl -fsS --max-time 20 "http://127.0.0.1:${uiport}/" || echo "")"
        injected="$(printf '%s' "$page" | sed -n 's/.*__KODO_API_ORIGIN__=\"\([^\"]*\)\".*/\1/p' | head -1)"
        if [ -z "$injected" ]; then
          bad "the bare UI page declares an API origin" "no __KODO_API_ORIGIN__ in the served HTML"
        elif [ "$injected" != "$api" ]; then
          bad "the bare UI points at the API that is actually running" \
              "page says '${injected}', the API is on '${api}'"
        else
          ok "the bare UI points at the API that is actually running"
        fi

        baretok="$(curl -fsS --max-time 20 -X POST "${injected:-$api}/api/auth/signup" \
                    -H 'Content-Type: application/json' \
                    -d "{\"email\":\"bare-$$@example.test\",\"password\":\"secret123\",\"name\":\"Bare\"}" \
                  | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).token||''}catch{''}" 2>/dev/null || echo "")"
        if [ -z "$baretok" ]; then
          bad "signup works from the bare UI origin" "no token returned (this is the 'Failed to fetch' bug)"
        else
          ok "signup works from the bare UI origin"
          barecap="$(curl -o /dev/null -s -w '%{http_code}' --max-time 20 "${api}/api/settings/capabilities" -H "Authorization: Bearer ${baretok}")"
          [ "$barecap" = "200" ] && ok "the signed-up session authenticates" \
                                 || bad "the signed-up session authenticates" "capabilities returned ${barecap}"
          bareme="$(curl -o /dev/null -s -w '%{http_code}' --max-time 20 "${api}/api/auth/me" -H "Authorization: Bearer ${baretok}")"
          [ "$bareme" = "200" ] && ok "/api/auth/me works for the signed-up session" \
                                || bad "/api/auth/me works for the signed-up session" "returned ${bareme}"
          barews="$(curl -fsS --max-time 20 "${api}/api/workspace" -H "Authorization: Bearer ${baretok}" || echo "")"
          case "$barews" in
            *no_workspace*) bad "the signed-up session resolves the CLI workspace" "got no_workspace" ;;
            *) ok "the signed-up session resolves the CLI workspace" ;;
          esac
        fi
      fi
    else
      bad "create a UI session against the installed API" "signup returned no token"
    fi
  else
    bad "locate the installed API port" "no server.json"
  fi

  case "$(cd /tmp && kodo_run ui status)" in *running*) ok "kodo ui status works" ;; *) bad "kodo ui status" "" ;; esac
  case "$(cd /tmp && kodo_run ui stop)" in *stopped*) ok "kodo ui stop works" ;; *) bad "kodo ui stop" "" ;; esac
  (cd /tmp && kodo_run server stop >/dev/null 2>&1) || true
else
  bad "kodo ui start from an installed package" "$(printf '%s' "$uistart" | tail -5)"
fi

# ── UI lifecycle, repeated ───────────────────────────────────────────────────
# One clean start/stop proves little: leaked state, an unreleased port or an
# orphaned worker only shows up on the SECOND start. Three cycles.
cycles_ok=1
i=1
while [ $i -le 3 ]; do
  set +e
  out="$(cd "$PROJECT" && kodo_run ui start --port 0 --api-port 0 --detach)"
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then cycles_ok=0; printf '     cycle %s start failed: %s\n' "$i" "$(printf '%s' "$out" | tail -2)"; break; fi
  p="$(node -p "require('${HOME_DIR}/.kodo/runtime/ui.json').port" 2>/dev/null || echo "")"
  a_p="$(node -p "require('${HOME_DIR}/.kodo/runtime/server.json').port" 2>/dev/null || echo "")"
  UI_PORTS="$UI_PORTS $p $a_p"
  curl -fsS -o /dev/null --max-time 20 "http://127.0.0.1:${p}/" || { cycles_ok=0; printf '     cycle %s: UI did not answer\n' "$i"; break; }
  (cd /tmp && kodo_run ui stop >/dev/null 2>&1) || true
  i=$((i+1))
done
(cd /tmp && kodo_run server stop >/dev/null 2>&1) || true
[ "$cycles_ok" -eq 1 ] && ok "three UI start/stop cycles all succeeded" \
                       || bad "repeated UI start/stop" "a later cycle failed — leaked state or an unreleased port"

# Orphan detection, scoped to THIS installation.
#
# `pgrep -f next-server` matches every Next.js server on the machine — a
# developer's own dev server, another project, an editor's. That indicted
# unrelated processes and reported a leak that did not exist. What actually
# matters is narrower and checkable: nothing Kodo started is still holding the
# ports it was given, and no survivor is running out of THIS install prefix.
orphans=0
for p in $UI_PORTS; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    orphans=$((orphans+1))
    printf '     port %s is still held after stop\n' "$p"
  fi
done
if pgrep -f "${PREFIX}/lib/node_modules/${PKG_NAME}" >/dev/null 2>&1; then
  orphans=$((orphans+1))
  printf '     a process from the installed package survived\n'
fi
[ "$orphans" -eq 0 ] && ok "no orphan UI/API processes remain (scoped to this install)" \
                     || bad "no orphan processes" "${orphans} leak(s) survived"

# ── Docker sandbox, FROM THE INSTALLED PACKAGE ───────────────────────────────
# The sandbox is verified elsewhere against the source tree. What is verified
# HERE is that an installed Kodo can find Docker and enforce the same rules —
# a packaging mistake could easily leave the runtime layer unreachable.
if docker info >/dev/null 2>&1; then
  # An unavailable sandbox must FAIL, never quietly run on the host.
  set +e
  out="$(cd "$PROJECT" && kodo_run run "say hi" --sandbox docker --model x --permission auto 2>&1)"
  rc=$?
  set -e
  case "$out" in
    *"will not run on the host"*|*"No model is configured"*|*"No API key"*)
      ok "the installed package enforces the sandbox contract (no host fallback)" ;;
    *)
      bad "installed sandbox contract" "$(printf '%s' "$out" | tail -3)" ;;
  esac

  # And the runtime itself is reachable from the installed package.
  if (cd "$PROJECT" && kodo_run doctor 2>&1 | grep -q "docker"); then
    ok "kodo doctor detects Docker from the installed package"
  else
    bad "doctor detects Docker" "Docker not reported by the installed CLI"
  fi
else
  printf '  \033[33m⏭\033[0m  Docker sandbox from the installed package\n'
  printf '     SKIPPED — the Docker daemon is not reachable here\n'
fi

# ── update / uninstall are npm-aware ─────────────────────────────────────────
upd="$(cd /tmp && kodo_run update --check || true)"
case "$upd" in
  *npm*) ok "kodo update knows npm owns this installation" ;;
  *) bad "kodo update is npm-aware" "$(printf '%s' "$upd" | tail -3)" ;;
esac

uninst="$(cd /tmp && printf 'n\n' | kodo_run uninstall || true)"
case "$uninst" in
  *"npm uninstall -g"*) ok "kodo uninstall points at the npm command" ;;
  *) bad "kodo uninstall is npm-aware" "$(printf '%s' "$uninst" | tail -4)" ;;
esac

mv "$MOVED" "$REPO"; MOVED=""

printf '\n%s passed, %s failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
