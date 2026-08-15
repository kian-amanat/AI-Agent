# Sessions

Every conversation is a session. Sessions persist, and resuming one restores the
agent's real working memory — the tool calls it made and what they returned, not
a summary of them.

## CLI sessions

```bash
kodo sessions              # list
kodo sessions --all        # beyond the most recent 20
kodo sessions --json
kodo resume a1b2c3         # continue one
kodo sessions rm a1b2c3    # delete one
```

```
  ID        WORKSPACE              TURNS  TITLE
  5r8tij    ~/projects/my-app      4      fix the failing tests
  aq1ceg    ~/projects/api         1      add rate limiting
```

The short id is the tail of the full id, like a git sha. `kodo resume` accepts
either.

Every `kodo run` also creates a session, and prints its id so you can pick the
work up interactively:

```
  session 5r8tij — resume with `kodo resume 5r8tij`
```

## Where they live

| Surface | Storage |
|---|---|
| CLI | `~/.kodo/sessions/<id>.json`, one file per session |
| Web UI / API | SQLite (`backend1/memory.db`), scoped to an account |

They are separate stores on purpose. The web app is multi-user, with sessions
scoped to an account id and a bound workspace; a system-installed CLI has no
account and no fixed working directory, so adopting that schema would mean
inventing a fake user row per machine and writing into whichever directory the
server happened to be launched from.

What *is* shared is the part that carries the intelligence: CLI sessions record
events in exactly the row shape the server's `turn_events` table uses, so the
same replay code — with its tool-call pairing repair and value-based compaction
— rebuilds a CLI session identically to a web one. Storage differs; memory
semantics do not.

## What is replayed

On resume, Kodo rebuilds the tool-loop conversation:

```
user       → what you asked
assistant  → what it said, plus the tool calls it made
tool       → what those calls actually returned
```

so the agent continues rather than restarting. Two invariants make this safe to
send back to a provider:

- **Pairing** — every assistant tool call has a matching result. A run killed
  mid-flight would otherwise leave a dangling call and the next request would be
  rejected outright. Unmatched calls are repaired, never emitted raw.
- **Budget** — history is compacted by value, not age alone. Recent turns stay
  verbatim; older tool payloads degrade to a one-line receipt
  (`read_file(auth.ts) → ✓`). The *fact* a tool ran is never dropped.

## Sandbox sessions

A session records what the agent did, not where it ran. You can resume a session
started with `--sandbox docker` without the sandbox, or vice versa — but note
that a container's filesystem does not persist between runs, so anything the
agent installed inside a previous sandbox is gone. Only workspace edits persist,
via the bind mount.

## Interactive session commands

Inside `kodo chat`:

| Command | Effect |
|---|---|
| `/clear` | Start a fresh session, keeping the same terminal |
| `/session` | Show the current session id and turn count |
| `/cwd` | Show the workspace |
| `/exit` | Quit |
