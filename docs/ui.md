# The web UI

```bash
kodo ui start --open
```

This starts two things and opens your browser:

```
Kodo Core → Local API → Next.js UI → browser
```

## Commands

```bash
kodo ui start [--port N] [--host H] [--api-port N] [--detach] [--open] [--builtin]
kodo ui status
kodo ui restart
kodo ui logs
kodo ui stop
```

| Command | Behaviour |
|---|---|
| `start` | Starts the Local API if it is not already running, then the UI. Verifies both are healthy before printing a URL. |
| `status` | PID, host, port, URL, workspace, uptime. `--json` for machines. Never prints the runtime token. |
| `restart` | Stops and starts, detached. |
| `logs` | Prints the log file path (`~/.kodo/logs/ui.log`). |
| `stop` | Graceful shutdown; escalates only if needed. Stops the **UI**; if the API is still running it says so and how to stop it. |

## Foreground vs background

By default `kodo ui start` holds your terminal and Ctrl+C stops the server
cleanly. To get your shell back:

```bash
kodo ui start --detach
```

The server keeps running in its own process group, so closing the terminal does
not kill it. Stop it with `kodo ui stop`.

## Ports

```bash
kodo ui start --port 4173      # explicit UI port
kodo ui start --port 0         # any free port
kodo ui start --api-port 9100  # explicit API port
```

An **explicit** port that is taken is an error — you asked for that port
specifically. The **default** API port (9000) is not a request: if something
else holds it (commonly your own `npm run backend`), Kodo quietly picks a free
one instead of failing a command that never mentioned 9000.

## Security

The UI and API bind to `127.0.0.1` by default. Binding anywhere else exposes an
agent that edits files and runs commands to everything that can reach your
machine, so it requires explicit intent:

```bash
kodo ui start --host 0.0.0.0 --yes-i-know
```

Without the flag you get exit code `5` and an explanation. With it, you get a
warning.

Other protections:

- Every mutating API request needs the runtime token, generated per start and
  stored `0600` in `~/.kodo/runtime/`.
- The token travels in the URL **fragment** (`#token=…`), which browsers never
  send to a server — it stays out of access logs and `Referer` headers.
- `/health` publishes a **hash** of the token, never the token, so it can prove
  identity without handing a working credential to every process on the machine.
- The API accepts any **loopback** origin, and nothing else. Not `*`, which
  would let any page you have open make credentialed requests to it.

## Which UI you get

**Installed from npm, you always get the real UI.** The package ships a prebuilt
production Next.js build, so there is nothing to build after installing and the
fallback below does not apply to you.

In a **source checkout**, `kodo ui start` serves the real Next.js application
only once it has been built. If it has not, Kodo says so and falls back to a
built-in single-page UI:

```
warning the full Kodo UI is unavailable — it has not been built.
  To use it: npm --prefix chatbot/my-chatbot-ui run build
  Falling back to the built-in single-page UI.
```

Build it once:

```bash
npm --prefix chatbot/my-chatbot-ui run build
```

Force the built-in page with `--builtin`.

## How the UI finds the API

The API's port is chosen at launch — it may not be 9000, and `--port 0` asks for
whatever is free. The Next.js pages are statically prerendered, so anything read
from `process.env` is frozen at build time. The origin therefore travels in the
URL that `kodo ui start` prints:

```
http://127.0.0.1:4173/?kodoApi=http://127.0.0.1:9000#token=…
```

The UI reads `?kodoApi`, **rejects any non-loopback value** (a crafted link must
not be able to point your session at someone else's server), and remembers it in
`localStorage` so ordinary navigation keeps working.

## Which project the UI works on

The directory you start it from:

```bash
cd ~/projects/my-app
kodo ui start
```

```
Local:     http://127.0.0.1:4173/?kodoApi=…#token=…
Workspace: ~/projects/my-app
```

That workspace is what the agent reads and writes. **No VS Code, no extension,
and no folder picking is involved** — the CLI passes the directory to the API at
startup, and the browser asks the API for it:

```
GET /api/workspace   →   { "workspace": "/Users/you/projects/my-app",
                           "name": "my-app",
                           "source": "cli",
                           "git": { "isRepository": true, "branch": "main" } }
```

The path travels **CLI → API → browser**, never through the URL. A path in a
query string or fragment would leak into shell history, server logs and
referrer headers, and would let anyone who can craft a link retarget the agent.
`GET /api/workspace` requires the same bearer token as every other workspace
route, so an unauthenticated caller on the loopback port gets nothing.

To work on a different project, start Kodo from that directory. If a server is
already running for another project, Kodo **refuses** rather than silently
retargeting it:

```
Kodo ui is already running for a different project: ~/projects/other-app.
  To use ~/projects/my-app instead, stop it first: kodo ui stop && kodo server stop
```

`kodo ui start --cwd /path/to/project` selects a workspace explicitly.

### The folder switcher is optional

The switcher in the composer still works and now starts on the project you
launched from. Use it to change projects from inside the UI; you never *have*
to touch it. Switching binds the new folder to your signed-in session, which
takes precedence over the CLI's workspace for that session.

### VS Code

The extension supplies a workspace its own way — it binds one to the auth
session (`POST /api/auth/workspace`). That still works and **wins** over the
CLI's workspace, because it is more specific: one API can serve several editor
windows, each on a different project. The two mechanisms converge on the same
server contract; neither requires the other. See [vscode.md](./vscode.md).

## Sessions

The web UI requires sign-in — it is the multi-user surface, and sessions are
scoped to an account and a bound workspace. The CLI does not: it runs as you, in
a directory you chose. The two keep separate session stores; see
[sessions.md](./sessions.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Port 4173 is already in use` | `kodo ui start --port 0`, or stop whatever holds it. |
| `Kodo ui is already running` | `kodo ui status` to see where; `kodo ui restart` to replace it. |
| "cleared a stale runtime record" | A previous server crashed. Harmless — Kodo reclaimed it. |
| The page loads but nothing works | Check `kodo ui status` and `kodo server status`. If the API is down, `kodo server start`. |
| `did not become healthy within 30s` | Read `~/.kodo/logs/ui.log`. Usually a missing production build. |
