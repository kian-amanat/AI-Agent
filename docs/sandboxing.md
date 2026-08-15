# Sandboxing

Kodo can run the agent inside a container instead of directly on your machine.

```bash
kodo run "upgrade the deps and fix the breakage" --sandbox docker
kodo chat --sandbox docker
```

## What "sandboxed" means here — and what it does not

The claim Kodo makes is narrow and testable: **every filesystem operation and
every process launch performed by an agent tool happens inside the sandbox.**
Not just `bash` — `read_file`, `write_file`, `edit_file`, `glob`, `list_files`,
`grep`, background tasks, package installs, and git commands the agent runs.

That distinction is the whole point. A sandbox that confines `bash` while
`write_file` still writes to the host is not a sandbox; it is a label. Kodo's
architecture makes that failure impossible to reach by accident:

```
Agent
  ↓
Tools
  ↓
ExecutionRuntime          ← the only way to touch a workspace or run a process
  ├── HostRuntime
  ├── DockerRuntime
  └── IncusRuntime
```

`backend1/tests/runtimeBoundary.test.mjs` fails the build if any tool regains
direct `fs`/`spawn` access, both by scanning the tool dispatcher's source and by
running every tool against a recording runtime and asserting the call arrived.

## What is deliberately NOT inside the sandbox

Stating this precisely is what makes the rest of the claim meaningful.

| Outside the boundary | Why |
|---|---|
| Undo snapshots (`~/.agent-history`) | Kodo's control plane. If undo history lived inside the sandbox, tearing the sandbox down would destroy your ability to revert the changes it made — inverting the safety property it exists for. Snapshots read the file *through* the runtime and write the copy to the host. |
| `.kodo/settings.json` bootstrap | Permissions govern what a runtime may do, so they must be read before one is constructed. Asking the sandbox about the rules that constrain the sandbox is circular. |
| Session, memory and database state | Not workspace content. |
| Model API calls | Kodo talks to your provider; the agent inside the container does not hold your key. |

## Verification is empirical, and failure is closed

`--sandbox` does not trust flags. Before any agent work starts, the runtime must
*prove* isolation on your machine, right now:

1. a command runs and reports the container's hostname, not yours;
2. the container sees its own small PID namespace, not the host's process table;
3. a file written through the runtime is readable back through it;
4. the host filesystem layout is not visible inside;
5. with networking off, there are no routes.

If any check fails, **the run does not start.** There is no fallback to the
host:

```
$ kodo run "..." --sandbox incus
error Could not start the incus sandbox: Incus is not available…
      Kodo will not run on the host when a sandbox was requested.
```

A silent downgrade would be the worst possible outcome — worse than an error —
because you asked for confinement, were not told you did not get it, and then
pointed an autonomous agent at your machine.

## Docker

```bash
kodo run "..." --sandbox docker
```

The container Kodo starts:

- `--cap-drop ALL`, `--security-opt no-new-privileges`
- `--network none` by default (an agent that cannot reach the network cannot
  exfiltrate the code it is reading)
- `--pids-limit` and `--memory`, so a runaway build cannot take the host down
- the workspace bind-mounted at `/workspace`, so your edits persist

File I/O goes through `docker exec`, **not** through the bind mount, even though
the mount would make host-side `fs` calls "work". Reading through the mount would
silently become a host escape the moment anyone runs without one.

Configure the image with `KODO_DOCKER_IMAGE` (default `node:22-bookworm-slim`).

**Status: verified.** `backend1/tests/dockerRuntime.test.mjs` runs 15 assertions
against a live daemon, including the decisive ones — a file created through the
runtime is present in the container and absent on the host, a file created on
the host is invisible to the runtime, and a sub-agent worktree exists inside the
container and nowhere on the host.

## Incus

```bash
kodo run "..." --sandbox incus
```

Same contract, via `incus exec`, with the workspace attached as a disk device.

**Status: implemented but NOT verified against a live daemon.** Incus was not
installed on the machine where it was written, so
`backend1/tests/incusRuntime.test.mjs` skips its live section there rather than
passing vacuously.

This is safe by construction rather than by promise: `createRuntime()` refuses
any sandbox whose `verifyIsolation()` does not return `isolated: true`, and the
Incus implementation performs the same empirical checks as the Docker one. On a
machine without a working Incus, `--sandbox incus` fails closed. It cannot
silently execute on the host. Treat it as reviewed-but-unproven until those
tests have run green somewhere with Incus installed.

## Worktrees and sub-agents

Both inherit the runtime. This is enforced, not conventional.

**Worktrees.** A sub-agent with `isolation: worktree` gets a real git checkout.
Under a sandbox that checkout is created **inside the container**, at
`/kodo-worktrees/<id>`, by running `git worktree add` in the sandbox. It never
touches your host filesystem.

This was previously an escape: the worktree was created on the host in
`os.tmpdir()` *and then* `derive()` refused — so a confined run had already
written a git checkout outside its workspace before failing. Fixed, and covered
by `tests/sandboxEscape.test.mjs` plus a live container test that asserts the
worktree exists in the container and does **not** exist on the host.

The sandbox image needs `git`. If it does not have one, Kodo says so precisely
rather than emitting a confusing git error.

**Sub-agents.** A sub-agent always executes through its parent's runtime:

```
parent = docker  →  child = docker
parent = incus   →  child = incus
```

`derive()` accepts a path inside the sandbox and refuses anything outside it. It
never returns a host runtime — that would be a one-line sub-agent escape. A
derived runtime also gets its own background-task registry, so a sub-agent
cannot read or kill its parent's processes.

## MCP under a sandbox

Host stdio MCP servers are **refused**, because one such server is a complete
bypass of everything above. This fails closed and is reported, not silent.
Remote `http`/`sse` servers are unaffected. Full model: [mcp.md](./mcp.md).

## Hooks under a sandbox

A project's `command` hooks run **inside the runtime**. `PreToolUse` and
`PostToolUse` fire inside every tool call, so leaving them host-side meant a
confined run executed project shell on the host hundreds of times per task.

Session-level hooks (`Setup`, `SessionStart`, `SessionEnd`) fire before a
runtime exists and remain host-side by necessity.

## Existing protections still apply

The sandbox is defence in depth, not a replacement. Above the runtime boundary,
unchanged:

- workspace path confinement (`safeResolve`)
- sensitive-file blocking (`.env`, credentials, keys)
- the bash command allowlist and the irreversible-command approval gate
- permission modes (`auto` / `ask` / `plan`)
- `KODO_DISABLE_BASH=1` to remove shell execution entirely

A rejected command never reaches a runtime at all.
