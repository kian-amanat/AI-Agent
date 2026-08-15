# Execution-path audit

Traced, not assumed. A tool importing a runtime module proves nothing — what
matters is what its *service dependencies* do.

The previous boundary test only scanned `executeTool`'s inline body, which gave
false confidence: four tool-reachable paths escaped through service modules.

## Escapes found

| # | Path | Reached from | What actually happened |
|---|---|---|---|
| 1 | `services/worktreeManager.mjs` → `execFile("git")` | `spawn_agent` with `isolation: worktree` | Created a **real host git worktree in `os.tmpdir()`**, then `derive()` threw. Host filesystem write outside the workspace, from a sandboxed run. |
| 2 | `services/worktreePatch.mjs` → `execFile("git apply")` | `review_patch` (`action: approve`) | Applied a patch to the workspace **on the host**, while the agent believed it was sandboxed. |
| 3 | `services/hooks.mjs` → `spawn(cmd, {shell:true})` | `PreToolUse` / `PostToolUse`, fired inside every tool call | Ran project-declared shell commands **on the host** during a sandboxed run. |
| 4 | `services/mcpClient.mjs` → `spawn(command, args)` | any `mcp__*` tool, `read_mcp_resource` | MCP servers are host child processes. An MCP server that edits files or runs commands bypassed the sandbox entirely. |

## Intentional host access (documented exceptions)

These are Kodo's own control plane. They do not act on the workspace on behalf
of the agent, and moving them inside a sandbox would break the property they
exist for.

| Path | Why it stays on the host |
|---|---|
| Undo snapshots (`~/.agent-history`) | If undo history lived inside the sandbox, tearing the sandbox down would destroy the user's ability to revert. Snapshots read the file *through* the runtime and write the copy to the host. |
| `.kodo/settings.json` bootstrap | Permissions govern what a runtime may do; they must be read before one exists. |
| Skill packs, subagent/command registries | Configuration, read once at run setup. Never executed. |
| `services/projectEvidence.mjs` | `/init` and `kodo init` only. Inspects a repository on the host *before* any agent run or runtime exists. |
| `services/mcpOAuth.mjs` → opens a browser | Host UX affordance. Cannot touch the workspace. |
| Session/memory/SQLite state | Not workspace content. |
| The CLI's own server lifecycle | Kodo infrastructure, not agent-directed. |

## The complete host-spawn inventory

Seven `spawn`/`execFile` sites remain outside `core/runtime/`. Every one is
classified, and the classification is enforced by tests rather than trusted.

| Site | Reachable from a tool? | Classification |
|---|---|---|
| `utils/syntax.util.mjs` — `python3 -c "ast.parse(...)"` | Yes, via `write_file`/`edit_file` on a `.py` file | **Documented exception.** Hermetic: a fixed command, content on stdin (never argv), no filesystem access, and `ast.parse` builds a tree rather than executing. Both properties are regression-tested in `sandboxEscape.test.mjs`. Caveat: it validates against the HOST's Python, not the sandbox's. |
| `routes/workspace.mjs` — git status/commit/push | No | **Host infrastructure.** User-initiated from the UI's git panel, not agent-directed. |
| `services/hooks.mjs` — `spawn(cmd, {shell:true})` | Only when no runtime is supplied | **Bounded.** Tool-level hooks receive `ctx.runtime` and execute inside the sandbox. This path remains for session-level hooks (Setup/SessionStart/SessionEnd), which fire before any runtime exists. |
| `services/mcpClient.mjs` — stdio MCP servers | Yes | **Gated.** Refused under a sandbox unless `allowHostAccessInSandbox: true` per server. `verify_ui` was the one path that reached this without the gate; it now refuses under a sandbox outright. |
| `services/mcpOAuth.mjs` — opens a browser | Indirectly | **Host UX.** Cannot touch the workspace. |
| `services/projectEvidence.mjs` — git inspection | No | **Pre-runtime.** `/init` and `kodo init` only, before any agent run exists. |
| `services/worktreeManager.mjs` — `git worktree` | Only via `HostRuntime.createWorktree` | **Runtime-owned.** Container runtimes use `container-worktree.mjs` instead; `architectureFreeze.test.mjs` prevents direct construction elsewhere. |

## Resolution

1, 2, 3 are fixed by routing through the runtime — see `core/runtime/contract.mjs`.
4 is fixed by failing closed: host MCP servers are refused under a sandbox
unless explicitly opted into per server. See `docs/mcp.md`.
