# Security model — running Kodo safely

Kodo is an autonomous coding agent. It reads and **writes real files** and **runs
shell commands** in a workspace. Treat it like giving an unattended developer a
terminal: powerful, and only as trustworthy as the guardrails around it.

This document describes the guardrails and how to run Kodo safely when someone
else is testing it.

## What confines the agent

| Boundary | Enforced by | Notes |
| --- | --- | --- |
| **File read/write/edit stays inside the workspace** | `safeResolve()` in `backend1/agents/nodes/agent_loop.mjs` — resolves every path and rejects anything not under the workspace root | Strong. Path traversal (`../`, absolute paths) is refused. |
| **Shell commands are allow-listed** | `validateBashCommand()` | Only known dev tools (`node`, `npm`, `git`, `ls`, …) may start a command. |
| **Shell commands stay inside the workspace** | `validateBashCommand()` token check | Any argument that is an absolute path, `~`, or `..` is refused, so `cat ~/.ssh/id_rsa`, `echo x >> ~/.zshrc`, `cp /etc/passwd .`, `find ~ -delete` are blocked. |
| **No command smuggling** | `validateBashCommand()` | Command substitution `$(…)`, backticks, process substitution, and inline-eval flags (`node -e`, `python3 -c`) are blocked — these previously let any command run past the allow-list. |
| **Child processes don't see secrets** | `sanitizedChildEnv()` | `OPENAI_API_KEY` and anything matching `*KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL*` is stripped from the environment handed to spawned commands. |
| **Secret files are off-limits** | `isSensitiveFilePath()` in `backend1/utils/path.util.mjs` | `.env`, `id_rsa`, `*.pem`/`*.key`, `.npmrc`, `credentials`, `data/settings.json`, etc. cannot be read, edited, written, `cat`-ed, or auto-preloaded. Templates (`.env.example`) are exempt. Same class Claude Code denies by default and Cursor's dotfile protection covers. |
| **No requests to internal/private hosts** | `isBlockedFetchHost()` in `fetch_url` | Loopback, RFC-1918 private ranges, and the cloud metadata IP (`169.254.169.254`) are refused. |
| **Every request is authenticated** | `requireUserSession()` in `routes/plannerAgent.mjs` | The `/run` endpoint requires a valid bearer token; each user's workspace is isolated. |

## How this maps to Claude Code / Cursor

Kodo now enforces the same security posture as those agents:

- **Default-deny for danger, not deny-everything** — read/grep/glob/list run freely; only genuinely dangerous shell patterns are blocked, so agent performance is unchanged.
- **Secret protection by default** — like Claude Code's default `deny` on `.env`/secret reads and Cursor's dotfile protection.
- **Workspace confinement** — file and shell access is pinned to the workspace, the way both tools scope an agent to its project directory.
- **Permission modes** — Kodo's `auto` / `ask` / `plan` mirror Claude Code's default / acceptEdits / plan modes. `ask` pauses for approval before the first change; `plan` disables all mutations.
- **Kill switch** — `KODO_DISABLE_BASH=1` removes shell execution entirely (stricter than either tool's defaults) for untrusted testing.

## Important: string filtering is defense-in-depth, not a jail

The shell allow-list makes casual and accidental damage very hard, and it blocks
every escape we could find (see the tests in
`backend1/tests/agent_loop.test.mjs`). But `npm install`, `npx`, and `pip3` run
third-party package code **by design** — a malicious dependency's post-install
script is arbitrary code the allow-list can't inspect. For a **hard** guarantee
that the agent cannot touch anything outside the workspace, run it with OS-level
isolation (below). String filtering raises the bar a lot; the OS is what makes it
a wall.

## Recommended way to let someone else test

Pick based on how much you trust the prompts that will be sent:

1. **Safest — no shell at all.** Set `KODO_DISABLE_BASH=1`. The agent can still
   read, edit, create files, grep, glob, and search the web, but cannot run any
   command. Good for testing the editing/UI behaviour with zero shell risk.

   ```bash
   KODO_DISABLE_BASH=1 npm --prefix backend1 run dev
   ```

2. **Safe — require approval before the first change.** Send requests with
   `permission_mode: "ask"` (the UI's approval mode). The agent pauses and shows
   the exact edits/commands before touching anything; nothing runs until the
   tester clicks Approve.

3. **Isolated — real sandbox.** Run the backend inside a container or a
   throwaway VM, or as a dedicated low-privilege OS user whose home contains
   nothing sensitive. This is the only setup that fully contains a malicious
   dependency or a novel escape. Example (Docker): mount only the workspace, run
   as a non-root user, and drop network egress you don't need.

For a family member kicking the tires locally, **option 1 or 2** is the right
default. Use option 3 if you'll run untrusted prompts or want a guarantee.

## Handling secrets

- `.env`, `backend1/data/settings.json`, and `.agent-history/` are git-ignored —
  keep it that way. Never commit an API key (see the note in
  `backend1/config/openai.mjs`).
- API keys live in `.env` or per-user Settings, never in source.
- If a key is ever exposed, rotate it at the provider.

## Reporting

Found something? Note the file and the exact input that triggers it, and add a
failing case to `backend1/tests/agent_loop.test.mjs`.
