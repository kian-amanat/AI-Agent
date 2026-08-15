# VS Code

**The VS Code integration is optional. Kodo does not require it, and nothing in
the runtime depends on it.**

## What is in this repository

This repository contains **no VS Code extension**. What it contains is the
integration contract an extension uses:

- the Local API (`backend1/server.mjs`) that an extension talks to;
- `POST /api/auth/handshake`, which writes a workspace-scoped token file so an
  extension can discover an authenticated session;
- SSE streaming of agent events on `/api/agent/run` and
  `/api/agent/run/:requestId/stream`.

Any extension lives in its own repository and consumes that API.

## Architecture

```
VS Code extension  (optional)
        ↓  HTTP + SSE
   Local API
        ↓
   Kodo Core
        ↓
   Agent → Tools → Runtime
```

The extension is a **client**. It must not contain an agent loop, tool
implementations, MCP handling, memory, planning or execution logic — there is
exactly one agent implementation and it lives in Kodo Core. An extension that
reimplemented any of that would immediately diverge from the CLI and the web UI.

## Running the API for an extension

```bash
kodo server start --detach
kodo server status
```

`kodo server` manages the Local API alone, with no browser UI.

## The handshake

The web UI, after sign-in, posts the session token scoped to a project:

```
POST /api/auth/handshake
{ "token": "...", "sessionId": "...", "workspacePath": "/abs/path" }
```

The server binds that auth session to the workspace and writes a token file the
extension can poll. `workspacePath` is **required** — a handshake with no
project scope is what previously let one project inherit another project's
login.

`DELETE /api/auth/handshake` clears it on sign-out.

## Migration contract

If you maintain a Kodo VS Code extension:

| Do | Do not |
|---|---|
| Call the Local API for everything | Reimplement the agent loop |
| Render the event stream | Interpret tool semantics yourself |
| Let Kodo own sessions, permissions, MCP | Keep a parallel session store |
| Let the user pick a sandbox via the API | Execute shell commands from the extension |

Backwards compatibility: the handshake, auth and SSE contracts are unchanged by
the CLI and runtime work. An existing extension continues to function.

## Sandboxing from an extension

Sandbox selection is a runtime concern, so an extension gets it by asking the
API to run with a sandbox rather than by doing anything itself. The same
fail-closed rule applies: if the sandbox cannot be verified, the run does not
start and no host fallback occurs.
