# Kodo architecture

## One agent

There is exactly one agent implementation. Every surface calls it.

```
                        Kodo Core
                  (backend1/core, agents/, services/)
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
     kodo CLI          Local API           VS Code ext
        │                   │                   │
        │              Next.js UI               │
        └───────────────────┼───────────────────┘
                            │
                    ExecutionRuntime
                 ┌──────────┼──────────┐
                 │          │          │
               Host       Docker      Incus
```

`graph_runner.runKodoGraph` is the single entry point. The CLI's `runTurn`, the
HTTP route's `startBackgroundRun`, and the benchmark driver all call it. Nothing
else implements an agent loop, and the boundary test suite is what keeps that
true.

## Routing: which path a message takes

Every turn starts at the router (`backend1/agents/nodes/router.mjs`), which
picks one of two execution paths. There are three kinds of message:

```
                        User message
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
   Conversation        Workspace            Action
      query              query               task
  "what is React?"  "where is the CLI    "add dark mode"
                       stored?"
         │                   │                   │
         ▼                   ▼                   ▼
      answer            agent_loop          agent_loop
   (web tools only)   (file/bash tools)   (file/bash tools)
```

**Conversation queries** answer from general knowledge, so they take the cheap
`answer` node: it streams instantly and holds only `web_search`/`fetch_url`.

**Workspace queries** are questions whose answer lives in *this* workspace —
"where is the CLI stored?", "which file contains the router?", "how is the
frontend structured?", "what framework does this project use?". They read like
conversation but cannot be answered without file tools, so `isWorkspaceQuery()`
routes them to `agent_loop`, where the agent runs a short targeted inspection
(list the directory → read the manifest → narrow with grep/glob) and answers
from what it actually saw. It does not run a full build loop for a question.

**Action tasks** ("fix the auth bug", "add a button") go to `agent_loop` as
before.

Anything the local classifier can't settle goes to one small LLM classification
call, which fails safe toward `agent_loop` — the agent can answer a question,
while the answer node can never make an edit.

### The honest-fallback contract

Kodo's agent mode holds `read_file`, `list_files`, `glob`, `grep` and `bash`.
So "I can't access your workspace" / "I only have access to the public
internet" is **never** a true statement about Kodo, and Kodo must never say it.
What it says instead depends on what actually happened:

| Situation | Response |
|---|---|
| Workspace query, workspace available | Inspect it, answer from the evidence found this turn |
| Workspace query, no workspace connected | "No workspace is currently connected" — established from the runtime, naming the path |
| Workspace query, a tool failed | The real cause, verbatim: `ENOENT`, permission denied, timeout, invalid path |
| Search ran, matched nothing | "Searched the workspace, found no match" — a fact about the project, not about Kodo |
| General-knowledge query | Answer directly, no workspace access |
| Action/task | `agent_loop` |

Paths named in an answer must come from a tool result in that turn or from the
turn's workspace listing — never from memory, `KODO.md`, or convention. A
confidently wrong path is worse than "I couldn't find it".

`backend1/tests/workspaceQuery.test.mjs` enforces all of the above.

## Where things live

| Path | What |
|---|---|
| `backend1/core/index.mjs` | The named import surface. Every client goes through it. Importing it requires no credentials, database or workspace. |
| `backend1/core/runtime/` | The execution boundary: `contract.mjs`, `host.mjs`, `docker.mjs`, `incus.mjs`, `index.mjs` (the gated selector). |
| `backend1/agents/` | The graph: router, answer, agent_loop (tools). |
| `backend1/services/` | MCP, hooks, memory, sessions, permissions, subagents, undo, verification. |
| `backend1/server.mjs` | The Local API (Fastify). |
| `cli/` | The `kodo` executable. Zero runtime dependencies. |
| `chatbot/my-chatbot-ui/` | The Next.js UI. |

## The two servers

They are genuinely different and are managed separately.

**`kodo server`** — backend1's Fastify app. THE Local API: sessions, SSE
streaming, settings, auth, workspace, git. The Next.js UI and the VS Code
extension already speak it.

**`kodo ui`** — what a browser loads. The Next.js application when it has been
built; the CLI's own built-in single-page UI otherwise (so `kodo ui` works
immediately after install, before any `npm install`). `kodo ui start` brings the
API up first if it is not already running.

Keeping them apart is not ceremony: the API must survive a UI restart (a Next.js
restart would otherwise kill in-flight agent runs), and the extension needs the
API with no UI at all.

### How the UI finds the API

The API's port is chosen when it launches — it may not be 9000, and `--port 0`
asks for whatever is free. The Next.js pages are statically prerendered, so
anything read from `process.env` is frozen at build time. The origin therefore
travels in the URL:

```
http://127.0.0.1:<ui>/?kodoApi=http://127.0.0.1:<api>#token=…
```

`app/lib/api.ts` reads `?kodoApi`, **rejects any non-loopback value**, and
remembers it in `localStorage` so later navigation keeps working. The token
travels in the fragment, which browsers never send to a server.

The API allows any *loopback* origin (`backend1/utils/cors.util.mjs`) — not
`*`, which would expose a credentialed, file-editing API to every page the user
has open.

## The execution boundary

See [sandboxing.md](./sandboxing.md). In short: every workspace read/write and
every process launch a tool performs goes through an `ExecutionRuntime`, so
selecting Docker or Incus moves *all* of it rather than only `bash`.

## Runtime state

`~/.kodo/` (override with `KODO_HOME` — this is what makes the lifecycle tests
able to start and kill real servers without touching your own):

```
~/.kodo/
  config.json        0600, user configuration
  runtime/ui.json    the UI server's PID, port, host, token
  runtime/server.json the API server's
  logs/              rotating server logs (never credentials)
  sessions/          CLI session transcripts
```

State files are written atomically (temp + rename). A recorded PID is never
signalled without first proving it is ours — by identity-token echo for Kodo's
own server, or by "does this PID hold the port we recorded" for external ones.

## Sessions

The CLI stores sessions as JSON under `~/.kodo/sessions`, in the exact row shape
backend1's `turn_events` table uses, so `buildConversationFromEvents` — the
agent's real working-memory replay, with tool-call pairing repair and
value-based compaction — rebuilds a CLI session identically to a web one.
Storage differs; memory semantics do not.

The CLI does not use the SQLite store because that store is scoped to a numeric
account id and lives in the server's working directory; a system-installed CLI
has neither.

## The workspace

Every request that reads or writes files needs to know which project it is
operating on. There are two ways that gets decided, and they converge in
`backend1/config/workspace.mjs`:

```
CLI       cd my-project && kodo ui start
            → WORKSPACE_PATH in the API process environment
            → CLI_WORKSPACE                    (per SERVER process)

VS Code   extension → POST /api/auth/{login,workspace,handshake}
            → auth_sessions.workspace_path     (per AUTH SESSION)
```

`resolveWorkspace()` prefers the session-bound path, then falls back to the
server's. Session-bound wins because it is more specific: one API can serve
several editor windows on different projects, and the server process cannot
know which one a given request came from.

It never falls back to `process.cwd()` or the repo root. The API runs with
`cwd=backend1`, so that fallback silently pointed the agent at Kodo's own source
tree — and the agent *writes* files.

The CLI fallback is deliberately conditional on `WORKSPACE_PATH` being set. A
hosted or multi-user deployment does not set it, resolves to `null`, and refuses
exactly as before — so an unconfigured account never inherits a view of whatever
project the server happens to run from. When the CLI sets it, the directory is
not incidental: the operator typed `kodo ui start` there, on their own machine,
on a loopback-bound server, as themselves.

The browser learns the workspace by asking (`GET /api/workspace`), authenticated
like every other workspace route. It is never passed through the URL, and there
is no endpoint that lets a page change it — the workspace chosen at startup is
authoritative, and the extension's session binding is the only override.

Workspace selection sits *above* the execution boundary: it decides which
directory the agent operates on, and the runtime still decides how. A sandboxed
run maps that workspace into the container; nothing here creates a host-only
path around the runtime.

## VS Code

The extension is optional and contains no agent implementation. It talks to the
Local API over HTTP/SSE, discovering its session through the workspace-scoped
handshake file that `POST /api/auth/handshake` writes. Nothing in this change
altered that contract — the CLI added a second way to acquire a workspace, it
did not replace the extension's.
