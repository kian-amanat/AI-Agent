# Release checklist

Work through this before publishing a Kodo release. Every item is either a
command you run or a fact you confirm — nothing here is "check it looks right".

Record the environment you verified on. A green run on one machine does not
verify another, and this document is the evidence trail.

```
Node:     node --version          (>= 20.12 required)
OS/arch:  uname -srm
Docker:   docker info --format '{{.ServerVersion}}'
Incus:    incus --version
```

---

## 1. Tests

```bash
npm test                       # core + CLI + docs validation
```

- [ ] Core suite passes
- [ ] CLI suite passes
- [ ] `docs vs implementation` passes
- [ ] **Every skip is accounted for** — read the skip reasons, do not skim the
      count. A skip means a claim was NOT tested.

Live model suites make real, billed calls and can fail on model behaviour rather
than code:

```bash
npm --prefix backend1 run test:e2e            # live MCP
npm --prefix backend1 run test:subagent-e2e   # live sub-agents
```

- [ ] Both run (not skipped) with a funded provider
- [ ] Any failure classified as code / model / infrastructure before shipping

## 2. Architecture freeze

```bash
node backend1/tests/architectureFreeze.test.mjs
```

- [ ] One agent entry point; `agentLoopNode` invoked only by the graph
- [ ] The CLI contains no agent internals
- [ ] Core imports with no credentials, database or workspace
- [ ] Container runtimes are constructed only via `createRuntime()`
- [ ] Only verified sandboxes are advertised

## 3. Security

```bash
node backend1/tests/runtimeBoundary.test.mjs
node backend1/tests/sandboxEscape.test.mjs
```

- [ ] Runtime boundary: no tool-reachable helper touches `fs`/`spawn` outside
      the documented allowlist
- [ ] All five escape-class regressions pass
- [ ] `docs/runtime-audit.md` still matches reality — re-run the audit greps if
      any service module gained a `spawn`/`execFile`
- [ ] No secret appears in `git grep -nE 'sk-[A-Za-z0-9]{20,}'`
- [ ] Local services still bind `127.0.0.1` by default; LAN bind still requires
      `--yes-i-know`

## 4. Sandboxes

```bash
node backend1/tests/dockerRuntime.test.mjs
node backend1/tests/incusRuntime.test.mjs
```

- [ ] Docker: 15/15 against a **real daemon** (the suite pulls its test image)
- [ ] Docker: host-vs-container file proofs ran (not skipped)
- [ ] Docker: in-container worktree proof ran (needs a git-capable image)
- [ ] Incus: either fully green against a **live daemon**, or explicitly
      reported BLOCKED — never assumed
- [ ] If Incus is still unverified, confirm it is still NOT advertised:
      `kodo help chat` must not list it, and `--sandbox incus` must refuse
      without `KODO_ENABLE_UNVERIFIED_INCUS=1`

## 5. Build

```bash
npm run ui:build               # Next.js production build must succeed
```

- [ ] UI production build exits 0
- [ ] `kodo ui start` serves the Next.js UI (not the built-in fallback)
- [ ] `kodo ui restart` keeps the same service and API origin
- [ ] `kodo ui stop` leaves zero orphans:
      `pgrep -f next-server; pgrep -f backend1/server.mjs; docker ps -aq --filter name=kodo-`

## 6. npm package (the primary distribution)

```bash
npm run pkg:build          # stage dist-npm/
npm run pkg:test           # pack → global install → drive from outside the repo
cd dist-npm && npm publish --dry-run
```

- [ ] `pkg:test` passes (all checks, including package self-containment,
      the CLI workspace contract, and a clean Next.js start)
- [ ] The UI log shows no `"next start" does not work with "output: standalone"`
      warning — the packaged `ui/next.config.mjs` is GENERATED to match how this
      artifact is actually run (`next start`), not copied from the source config
      (which targets the standalone release tarball)
- [ ] Packed and unpacked sizes reported and sane
- [ ] Dry-run shows no `.env`, `.db`, `.git`, tests or credentials
- [ ] Manifest has **no lifecycle scripts** — `npm install` must not run Kodo
- [ ] All three manifests report the same version (`architectureFreeze` checks this)

Publishing — **pass `--tag` explicitly**. npm assigns `latest` by default even
to a prerelease, and the dry-run notice does not reflect `publishConfig.tag`:

```bash
cd dist-npm
npm publish --tag next      # a prerelease: 2.0.0-rc.3
npm publish --tag latest    # a stable release, ONLY after the matrix is verified
```

- [ ] A prerelease went to `next`, never `latest`

**Publish from `dist-npm/`, never from the repository root.** This is the bug
that shipped 2.0.0-rc.1. The root manifest had been renamed `kodo-agent` and
given a `bin`, so `npm publish` at the root succeeded and published the source
tree with **no `dependencies`** — it installed fine and then died on first real
use with `Cannot find package '@langchain/core'`. Every root manifest is now
`private: true` so npm refuses outright (`EPRIVATE`), and `architectureFreeze`
fails if that is ever undone. Confirm anyway:

```bash
npm pkg get name            # in the directory you are about to publish from
                            # → "kodo-agent" ONLY inside dist-npm/
```

- [ ] `npm publish` was run inside `dist-npm/`
- [ ] The published manifest has dependencies — this is not optional:

```bash
npm view kodo-agent@<version> dependencies    # must NOT be empty
```

- [ ] After publishing, install **from the registry** and re-verify that the
      package is self-contained — `--version` and `doctor` are not sufficient,
      they never load the agent:

```bash
npm install -g kodo-agent@next
cd /tmp && kodo --version && kodo doctor && kodo ui start && kodo ui stop
```

## 7. Release artifacts (standalone tarballs)

```bash
npm run release:build          # tarballs + SHA256SUMS + latest.txt
npm run release:test           # installer end-to-end against a local host
```

- [ ] Artifacts build and the credential audit passes (it fails the build on a
      leaked key, a `.env`, a `.db`, or a bundled `node_modules`)
- [ ] `SHA256SUMS` generated
- [ ] Installer test: 12/12, including **checksum mismatch refused**
- [ ] On Linux, confirm GNU tar reported `reproducible` — macOS bsdtar cannot
      pin mtime, so its artifacts are not byte-reproducible

## 8. Installation

- [ ] Source install works from **outside** the repository
- [ ] Release install works and the launcher points at the versioned directory
- [ ] Reinstall of the same version is idempotent
- [ ] `~/.kodo` survives a reinstall
- [ ] A failed install leaves the previous installation untouched
- [ ] Unsupported architecture and missing release both fail with a named reason
- [ ] Installer output contains no credentials

## 9. Update / uninstall

- [ ] `kodo update` on the current version reports "already up to date"
- [ ] `kodo update` refuses an artifact whose checksum does not match
- [ ] `kodo update` preserves `~/.kodo`
- [ ] `kodo uninstall` requires explicit confirmation before removing config
- [ ] `kodo uninstall` cancelled leaves everything in place
- [ ] Neither command ever touches project files

## 10. CLI contract

```bash
npm run validate:docs
```

- [ ] Every documented command exists
- [ ] Every documented flag is accepted by its parser
- [ ] Every implemented command is documented
- [ ] No quick-start instruction points at a release host that does not exist

## 11. Documentation

- [ ] `README.md` matches the actual system
- [ ] `docs/installation.md` distinguishes source install from a future public
      release, and does not invent URLs
- [ ] `docs/incus.md` states its real verification status
- [ ] `docs/sandboxing.md` still says failure never falls back to host
- [ ] Windows documented as **not supported**, with the specific reasons
      (`install.sh` is POSIX-only; server lifecycle needs lsof/ps)

## 12. Versioning

- [ ] `cli/package.json`, `backend1/package.json` and the root manifest agree
- [ ] A prerelease version (`-rc.N`) is published to `next`, not `latest`
- [ ] `npm view kodo-agent version` matches `kodo --version` after installing
- [ ] `kodo --version` reports it
- [ ] `kodo version --json` shows matching `cli` and `core`
- [ ] Git tag matches

## 13. Rollback

- [ ] The previous versioned directory under `~/.local/share/kodo` still exists
- [ ] Repointing the launcher at it restores the previous version
- [ ] Configuration is untouched by the rollback

---

## Sign-off

Do not publish while any box above is unchecked or any claim is unverified.
Prefer shipping with a documented blocker over shipping with a false claim.

```
Version:      _______
Verified on:  _______  (Node __, OS __, arch __)
Docker:       _______  Incus: _______
Blockers:     _______
```
