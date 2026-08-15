# Execution runtime — migration plan

Written after reading the actual tool layer, not from the diagram.

## What the audit found

The good news: the workspace-affecting surface is **small and already
centralised**. `agents/nodes/agent_loop.mjs` has 22 `fs.*` calls and 2 `spawn`
calls, and the tools do not call them directly — they go through eight helpers.

| Primitive | Current implementation | Tools that reach it |
|---|---|---|
| `stat` | `safeStat` (line 275) | `readFileSafe` |
| `readFile` | `readFileSafe` (287) | `read_file`, `edit_file`, `write_file` |
| `writeFile` | `writeFileAtomic` (utils/syntax.util.mjs) | `edit_file`, `write_file` |
| `walk` | `walkWorkspace` (317) | `ctx.workspaceSnapshot` → `glob`, `list_files` |
| `grep` | `grepWorkspace` (838) → `runBash` | `grep` |
| `exec` | `runBash` (699) | `bash`, `grep`, postEdit hook, Stop hook, `detectGrepTool` |
| `execBackground` | `runBashBackground` (766) | `bash --background` |
| background I/O | `readBackgroundTaskOutput` (808), `killBackgroundTask` (795) | `bash_output`, `kill_shell` |

So the refactor is: **define an interface over those eight primitives, move the
current bodies into `HostRuntime` unchanged, and make the helpers delegate.**
No tool logic changes. That is what makes "identical behaviour" verifiable
rather than hoped-for.

`glob` and `list_files` deserve a note: they read `ctx.workspaceSnapshot`, which
is built once per run by `walkWorkspace`. Routing `walkWorkspace` through the
runtime therefore routes both tools, with no change at the call sites.

## What must NOT move

A sandbox boundary is only meaningful if you can say precisely what is inside
it. Three things stay on the host, deliberately:

1. **Undo snapshots** (`snapshotForUndo` → `~/.agent-history`). This is Kodo's
   own control plane. Putting the undo history inside the sandbox would mean a
   container teardown destroys the user's ability to revert — the opposite of
   the safety property it exists for. Snapshots are taken by reading the file
   *through the runtime* and writing the copy to the host.
2. **Settings bootstrap** (`.kodo/settings.json`). Permissions must be known
   *before* a runtime is constructed, because they govern what the runtime is
   allowed to do. Reading them is a host operation by necessity.
3. **Session/memory/DB state.** Not workspace content.

`docs/security.md` states this boundary; anything else inside the workspace goes
through the runtime.

## Phases

Each phase ends with the full suite green.

**Phase 1 — interface + HostRuntime.** `core/runtime/` gains an
`ExecutionRuntime` contract and `HostRuntime`, whose method bodies are the
existing implementations moved verbatim. Nothing is wired up yet; tests prove
`HostRuntime` behaves like the current helpers.

**Phase 2 — route every tool.** `ctx.runtime` is threaded into `executeTool`.
The eight helpers become thin delegations. A guard test asserts no direct
`fs`/`spawn` call survives in the tool paths.

**Phase 3 — DockerRuntime.** Real container: workspace bind-mounted, `exec` via
`docker exec`, and `readFile`/`writeFile`/`walk` **also** via `docker exec` — not
via the bind mount. That distinction is the whole point: implementing file I/O
through the mount would work today and silently become a host escape the moment
someone runs without a mount.

**Phase 4 — isolation proof, then and only then a flag.** Integration tests that
create a file *inside* the container and assert the host cannot see it, and vice
versa. `--sandbox` is gated behind a runtime `verifyIsolation()` self-check that
runs at startup; a runtime that cannot prove isolation refuses to run rather
than degrading to the host.

**Phase 5 — IncusRuntime.** Same shape as Docker. Incus is not installed on this
machine, so its integration tests skip — and the flag stays refused-by-default
under the same self-check, which means an unverifiable Incus runtime cannot
silently execute on the host.

**Phase 6 — Next.js UI through `kodo ui`.**

## Non-negotiables

- `HostRuntime` must not change observable behaviour. The existing 1070-assertion
  suite is the check.
- No `--sandbox` flag ships before Phase 4's proof exists.
- A runtime that fails `verifyIsolation()` **refuses**. It never falls back to the
  host — a silent downgrade is how "sandboxed" becomes a lie.
