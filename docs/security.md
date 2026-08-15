# Security model

Kodo is an agent that edits files and runs shell commands as you. The CLI does
not relax any protection the existing agent already has, and adds boundaries of
its own where being a system-installed tool creates new exposure.

## What was preserved

The CLI passes `permissionMode` straight through to the same agent the web app
uses. Nothing in the CLI converts a restricted mode into an unrestricted one.

- `auto` — proceeds under the workspace's `.kodo/settings.json` permission rules,
  which still gate dangerous commands and sensitive files.
- `ask` — pauses before the first mutation.
- `plan` — explores without mutating.

Sensitive-file protection (`.env`, credentials, keys — `isSensitiveFilePath`),
the bash command validator, and hook-based vetoes are all core behaviour and are
untouched.

## Credentials

**Never printed.** Every path out of `kodo config` goes through redaction,
including `config get apiKey` and `status --json`. If you need the real value
you already have it; printing it into a terminal, a shell history and a CI log
is how it leaks.

**Never borrowed.** The agent has an internal credential fallback chain that
ends at `backend1/data/settings.json` — the *web app's* saved settings, belonging
to whichever account last used the browser UI. The CLI always passes an explicit
model route and never lets that fallback fire. An unconfigured terminal user is
told they are unconfigured, not quietly billed to someone else's key. (The
benchmark runner refuses for the same reason.)

**Stored 0600.** `~/.kodo/config.json` and the runtime state files are written
with owner-only permissions, and the directory is created 0700.

**Never in an image layer.** The Dockerfile takes credentials at run time only.
`.dockerignore` excludes `.env`, `*.db` and local state.

## The local server

`kodo ui` exposes an agent that can edit files and run commands. Four things
guard it:

**Loopback by default.** `127.0.0.1`. Binding anywhere else exits 5 unless you
pass `--yes-i-know`, and prints what you are exposing.

**A runtime token per start.** 32 random bytes, generated at startup, stored
0600 in `~/.kodo/runtime`, required on every `/api` request. This is what closes
the DNS-rebinding hole a bare localhost server would have: a malicious page can
make your browser POST to 127.0.0.1, but it cannot read a file to learn the
token.

**Origin checking.** Browser requests from a non-loopback origin are refused
with 403, independently of the token.

**Identity by hash, not by token.** `/health` is unauthenticated — the lifecycle
manager and `doctor` poll it before they hold any token. It publishes
`sha256(token)`, never the token. Whoever already holds the token can recompute
the hash and confirm "this process is the one my state file describes"; anyone
else learns nothing usable. Publishing the token there would have handed a
working bearer credential to every process on the machine, including other
users' on a shared host.

The token reaches the browser through the URL **fragment** (`#token=…`), which
browsers never transmit to a server and which therefore stays out of access logs
and `Referer` headers. The page strips it from the address bar on load and keeps
it in memory only.

## Process signalling

`kodo ui stop` never sends a signal to a PID it has not positively identified.
PIDs get recycled; a lifecycle manager that trusts a number in a file will
eventually kill an unrelated process belonging to the user. The identity
challenge above is required first, and a process that fails it is left alone
while the stale record is cleared.

This is covered by a test that records the *test runner's own PID* as the
server: if `stop()` signalled on PID alone, that test would kill itself.

## Logging

`~/.kodo/logs/*.log` records lifecycle events and request failures. It does not
record the runtime token, the API key, authorization headers, or file contents.
Rotation is size-based (5 MB, one previous file kept).

A closed stdout never kills the server: an unhandled `EPIPE` would take down a
process in the middle of an agent run, losing the run and orphaning its child
processes. Logging does not get a veto over real work.

## Containers

The container is the boundary, so nothing in the documented invocations weakens
it: non-root user, no `--privileged`, no `docker.sock` mount, no host
networking. Mounting the Docker socket in particular is not a convenience — it
lets the agent start a privileged container and escape entirely.

The agent can reach exactly what you mounted:

```bash
docker run --rm -it -v "$PWD:/workspace" -e OPENAI_API_KEY kodo/kodo
```

## Reporting

Security issues: see `SECURITY.md` at the repository root.
