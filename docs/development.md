# Development

## Setup

```bash
git clone <repo> kodo && cd kodo
npm --prefix backend1 install
npm --prefix chatbot/my-chatbot-ui install
```

Create `backend1/.env` (git-ignored):

```
OPENAI_API_KEY=sk-your-key
OPENAI_BASE_URL=https://api.openai.com/v1
DEFAULT_MODEL=gpt-4.1-nano
```

## Layout

| Path | What |
|---|---|
| `backend1/core/` | The named import surface. `runtime/` holds the execution boundary. |
| `backend1/agents/` | The LangGraph agent: router, answer, agent_loop (tools). |
| `backend1/services/` | MCP, hooks, memory, sessions, permissions, sub-agents, undo. |
| `backend1/server.mjs` | The Local API (Fastify). |
| `cli/` | The `kodo` executable. Zero runtime dependencies. |
| `chatbot/my-chatbot-ui/` | The Next.js UI. |
| `docs/` | This documentation. |

## Running things

```bash
node cli/bin/kodo.mjs --version     # the CLI, without installing
npm run backend                     # the Local API on :9000
npm run frontend                    # the Next.js UI in dev mode
npm run kodo -- run "..."           # the CLI through npm
```

Or install the launcher and use `kodo` directly:

```bash
sh install.sh
```

## Tests

```bash
npm test                 # everything: core + CLI, reporting both
npm run test:core        # backend1 only
npm run test:cli         # CLI only
```

`npm test` deliberately does **not** chain with `&&` — the core suite ends with
two live model tests, and under `&&` one flaky live test would hide the entire
CLI suite.

Individual suites:

```bash
cd backend1
node tests/runtimeBoundary.test.mjs   # no tool may touch fs/spawn directly
node tests/sandboxEscape.test.mjs     # the four escape regressions
node tests/dockerRuntime.test.mjs     # live container isolation proof
node tests/incusRuntime.test.mjs      # skips loudly without a daemon
```

```bash
cd cli
node tests/lifecycle.test.mjs         # real servers, signals, stale PIDs
node tests/e2e.test.mjs               # full start → API → stop scenario
node tests/sandbox.test.mjs           # the --sandbox contract
```

### Docker tests

They pull `alpine:3.20` (and `alpine/git` for the worktree proof) if missing,
because Docker Desktop prunes unused images and a suite that merely *skips*
would quietly stop proving anything.

```bash
KODO_TEST_DOCKER_IMAGE=alpine:3.20 node backend1/tests/dockerRuntime.test.mjs
```

### Incus tests

Skip loudly without a daemon. If you have one, run them and record the results
in `docs/incus.md` — that runtime is unverified until someone does.

### Live model tests

`mcpLiveE2E` and `subagentLiveE2E` make real, billed provider calls. They are
opt-in via `KODO_E2E_OPTIONAL=1` (set by `npm test`) and can fail on model
behaviour rather than code. Check whether a failure is in one of those before
assuming a regression.

## The invariant to preserve

```
Agent → Tools → ExecutionRuntime → { Host | Docker | Incus }
```

If you add a tool, or a service a tool calls, it must not reach `fs` or
`child_process` directly. `runtimeBoundary.test.mjs` scans the dispatcher and
runs every tool against a recording runtime; `sandboxEscape.test.mjs` covers the
service-level paths that a source scan alone would miss.

Intentional host access is documented in `docs/runtime-audit.md`. Add to that
table rather than working around the check.

## Building the UI

```bash
npm --prefix chatbot/my-chatbot-ui run build
npm --prefix chatbot/my-chatbot-ui run typecheck
```

`kodo ui start` needs a **production** build; a dev `.next` is detected and
reported.

## Conventions

- ESM everywhere, Node 20.12+.
- Tests are plain node scripts with `assert`, printing `✅`/`❌` and exiting
  non-zero on failure. No framework.
- Comments explain *why*, especially where a simpler-looking approach is wrong.
