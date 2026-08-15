# Release notes

## 2.0.0 — UNRELEASED (draft)

> **Status: not published.** The current candidate is `2.0.0-rc.4`. This section
> is the draft for the stable release and is finalised only when the gates in
> [release-checklist.md](./release-checklist.md) pass. Nothing here should be
> read as a claim about a published version.

Kodo 2.0 makes the **command line the primary interface**. The agent, tools, MCP
integration, permissions, memory, skills and sandboxing are the same system as
before — what changed is that you no longer need an editor to use them.

### Installation

```bash
npm install -g kodo-agent      # stable, once released
npm install -g kodo-agent@next # the current release candidate
```

No clone, no `npm install` inside the project, no UI build step. The package
ships the CLI, Kodo Core, the Local API and a prebuilt production web UI.

### Highlights

**A standalone CLI.** `kodo`, `kodo run`, `kodo chat`, `kodo init`, `kodo doctor`,
`kodo status`, `kodo config`, `kodo sessions`, `kodo resume`, `kodo ui`,
`kodo server`, `kodo update`, `kodo uninstall`. Machine-readable `--json` and
meaningful exit codes throughout.

**VS Code is optional.** The web UI takes its project from the directory you
started it in:

```bash
cd my-project
kodo ui start
```

The CLI passes that workspace to the Local API; the browser asks the API for it
(`GET /api/workspace`). The path never travels through a URL. Previously the
workspace could only be supplied by the VS Code extension, so a CLI-only install
could not chat at all — it answered *"No project connected yet"*. The extension's
own binding still works and takes precedence for its session.

Starting Kodo in a second project while a server runs for another is **refused**
rather than silently retargeted.

**Container sandboxing.** `--sandbox docker` runs the agent inside a container,
with filesystem and process isolation covering the tools, not just shell
commands. If a requested sandbox cannot start, Kodo **fails closed** — it never
falls back to running on your machine.

**Security.** Local services bind loopback only; a LAN bind requires an explicit
acknowledgement. The API token is never printed in health output. Sub-agents
inherit the parent runtime. Hooks, MCP stdio servers, git worktrees and patch
application all execute through the runtime boundary.

### Known limitations

- **Platform support is narrow.** Only **macOS arm64** is Supported. macOS x64,
  Linux x64, Linux arm64 and Windows x64 are **Experimental** — implemented and
  reviewed, but not executed on that platform. See
  [installation.md](./installation.md#supported-platforms).
- **Incus is not supported.** The implementation exists but has never been
  verified against a live daemon, so it is not advertised and `--sandbox incus`
  refuses without an explicit opt-in environment variable.
- **Installed size is ~560 MB**, dominated by Next.js (~297 MB) — the cost of
  shipping a real web UI. The package itself is 6.3 MB packed / 24 MB unpacked.
- **Multiple concurrent projects are not supported.** Kodo refuses rather than
  sharing state between them.
- `2.0.0-rc.1` was published from the repository root and is **broken** — it
  installs with no dependencies. Do not use it.

### Upgrading

```bash
npm install -g kodo-agent@latest   # or: kodo update
```

Configuration in `~/.kodo` is preserved. See
[installation.md](./installation.md) for uninstall.
