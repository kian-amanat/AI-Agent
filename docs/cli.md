# CLI reference

Every command and option below exists in the implementation. Options are listed
exactly as the parser accepts them.

## Global options

Accepted by every command:

| Option | Effect |
|---|---|
| `-h`, `--help` | Show help for the command and exit without running it. |
| `-v`, `--version` | Print the CLI version. |
| `--verbose` | More detail on stderr. |
| `--debug` | Internal diagnostics and stack traces on stderr. |
| `--no-color` | Disable colour. Colour is off automatically when output is not a terminal, and `NO_COLOR` is honoured. |

**Stream discipline:** results go to stdout, everything else to stderr. This is
what makes `kodo run --json | jq` and `kodo chat > transcript.md` work.

---

## `kodo`

Start an interactive session in the current directory. Equivalent to
`kodo chat`. With no terminal attached (piped), prints help instead of silently
waiting on stdin.

```bash
cd my-project
kodo
```

---

## `kodo chat`

Interactive coding session.

```
kodo chat [--cwd DIR] [--model NAME] [--permission MODE] [--resume ID] [--sandbox KIND]
```

| Option | Default | Meaning |
|---|---|---|
| `--cwd DIR` | current directory | Project to work in. |
| `--model NAME` | configured model | Override the model for this session. |
| `--permission MODE` | `auto` | `auto`, `ask`, or `plan`. See [permissions.md](./permissions.md). |
| `--resume ID` | — | Continue a previous session (`kodo sessions` lists them). |
| `--sandbox KIND` | `host` | `host`, `docker`, or `incus`. See [sandboxing.md](./sandboxing.md). |

In-session commands: `/exit`, `/clear` (start a fresh session), `/session`
(show the current id), `/cwd`.

Ctrl+C while the agent is working stops **that task** and returns you to the
prompt. Ctrl+C at the prompt exits.

```bash
kodo chat --permission ask          # confirm before the first mutation
kodo chat --sandbox docker          # run the agent inside a container
kodo chat --resume a1b2c3
```

---

## `kodo run`

Run one task and exit. Built for scripts and CI.

```
kodo run "<task>" [--cwd DIR] [--json] [--quiet] [--model NAME] [--permission MODE] [--sandbox KIND] [--session ID]
```

| Option | Meaning |
|---|---|
| `--json` | Emit JSON Lines events on stdout and nothing else. |
| `--quiet` | Suppress tool-activity output on stderr. |
| `--cwd DIR` | Project to work in. |
| `--model NAME` | Override the configured model. |
| `--permission MODE` | `auto`, `ask`, `plan`. |
| `--sandbox KIND` | `host`, `docker`, `incus`. |
| `--session ID` | Continue an existing session instead of starting one. |

Reads the task from stdin when no argument is given:

```bash
echo "fix the lint errors" | kodo run
```

Clarifying questions are answered automatically in `run` (there is nobody to
ask), and the agent is told to proceed on its best judgment and state its
assumptions — rather than blocking a CI job.

```bash
kodo run "add dark mode to the dashboard"
kodo run "fix the failing tests" --cwd ./api
kodo run "upgrade deps" --sandbox docker
kodo run "summarize the architecture" --json | jq -r 'select(.type=="agent_message").text'
```

### `--json` event stream

One JSON object per line:

| `type` | Fields |
|---|---|
| `session_started` | `sessionId`, `requestId`, `workspace` |
| `agent_message` | `text` (streamed in fragments) |
| `agent_progress` | `stage`, `message` |
| `file_changed` | `action`, `path`, `language`, `hunks` |
| `todo_updated` | `todos` |
| `usage` | `usage` |
| `agent_error` | `error`, `details` |
| `session_completed` | `success`, `cancelled`, `editedFiles`, `usage` |

---

## `kodo init`

Set up Kodo in a project. Creates `.kodo/` and generates `KODO.md` by inspecting
the repository — the document is validated against real files before it is
written, and a draft making unsupported claims is discarded rather than saved.

```
kodo init [--cwd DIR] [--force] [--no-instructions] [--model NAME]
```

| Option | Meaning |
|---|---|
| `--force` | Regenerate `KODO.md` even if one already exists. |
| `--no-instructions` | Create `.kodo/` only; skip `KODO.md` generation (no model call). |

An existing `.kodo/settings.json` is never overwritten.

---

## `kodo config`

```
kodo config <get|set|unset|list|path> [key] [value]
```

| Subcommand | Effect |
|---|---|
| `list` | Show effective configuration with the source of each value. |
| `get <key>` | Read one key. Secrets print masked. |
| `set <key> <value>` | Write to `~/.kodo/config.json` (mode `0600`). |
| `unset <key>` | Remove a key. |
| `path` | Print the config file path. |

Supports `--json` on `list`. Even in JSON mode secrets are masked — that output
ends up in CI logs.

```bash
kodo config set model gpt-4.1-nano
kodo config set apiKey sk-your-key
kodo config set ui.port 4173
kodo config get model
kodo config list
```

Precedence and all keys: [configuration.md](./configuration.md).

---

## `kodo ui`

Manage the local web UI. See [ui.md](./ui.md).

```
kodo ui <start|stop|restart|status|logs> [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--port N` | `4173` | UI port. `0` picks a free one. |
| `--host H` | `127.0.0.1` | Interface to bind. |
| `--api-port N` | `9000`, or a free port if that is taken | Port for the Local API. |
| `--detach` | off | Run in the background and return the shell. |
| `--open` | off | Open the URL in your browser. |
| `--builtin` | off | Serve the CLI's built-in page instead of the Next.js UI. |
| `--json` | off | Machine-readable output. |
| `--yes-i-know` | — | Required to bind a non-loopback host. |
| `--cwd DIR` | current directory | Workspace to serve. |

```bash
kodo ui start --detach --open
kodo ui status
kodo ui logs            # prints the log file path
kodo ui stop
```

`kodo ui start` starts the Local API first if it is not already running.

**Security:** binding to anything other than loopback exposes an agent that
edits files and runs commands to your network. It requires `--yes-i-know` and
prints a warning. Exit code `5` if you omit the flag.

---

## `kodo server`

The Local API alone (backend1's Fastify app) — what the Next.js UI and the
optional VS Code integration talk to. Same subcommands and lifecycle semantics
as `kodo ui`.

```bash
kodo server start --detach
kodo server status
kodo server stop
```

Use this when you want the API without a browser UI.

---

## `kodo sessions`

```
kodo sessions [list|rm <id>] [--json] [--all]
```

Lists your sessions with a short id, workspace, turn count and title. `--all`
shows more than the most recent 20.

```bash
kodo sessions
kodo sessions rm a1b2c3
```

---

## `kodo resume`

```
kodo resume <id>
```

Continue a session by short or full id. The agent's real working memory — the
tool calls and their results — is replayed, not a summary.

---

## `kodo status`

Fast, network-free snapshot: version, workspace, git state, model, permission
mode, UI and API server state, session counts. Supports `--json`.

Never prints credentials, in either mode.

---

## `kodo doctor`

Checks the installation and reports what is broken. Every check is independently
guarded, so a broken installation still produces a full report rather than a
stack trace.

Checks: Node version, CLI, Kodo Core (and CLI/Core version match), `~/.kodo`,
configuration, provider, **live API connectivity**, workspace, git, project
config, `KODO.md`, MCP servers (a live probe), UI and API server state, and
which sandboxes are actually usable.

```bash
kodo doctor
kodo doctor --json
kodo doctor --timeout 30000
```

Exit code `3` if a required check failed. Never prints secrets — it reports
whether a key works, never what it is.

---

## `kodo update`

```
kodo update [--check]
```

Updates the source checkout Kodo was installed from (`git pull` plus a
dependency install). Refuses to run over uncommitted changes. Never touches
`~/.kodo`.

`--check` reports whether updates are available without applying them.

There is no published binary release channel yet; see
[installation.md](./installation.md).

---

## `kodo uninstall`

```
kodo uninstall [--cache] [--config] [--all] [--yes] [--json]
```

| Option | Removes |
|---|---|
| *(none)* | The `kodo` launcher only. |
| `--cache` | Also logs, runtime state and saved sessions. |
| `--config` | Also `~/.kodo/config.json`, **including your API key**. |
| `--all` | Both of the above. |
| `--yes` | Skip confirmation. |

Removing configuration requires typing `remove` to confirm. Running servers are
stopped first so nothing is orphaned. Your projects, their `.kodo/` directories
and `KODO.md` are never touched, and neither is the source checkout.

---

## `kodo completion`

```
kodo completion <bash|zsh|fish>
```

```bash
eval "$(kodo completion bash)"    # add to ~/.bashrc
eval "$(kodo completion zsh)"     # add to ~/.zshrc
kodo completion fish > ~/.config/fish/completions/kodo.fish
```

---

## `kodo version`

Prints the CLI version. `kodo version --json` also reports the Core and Node
versions. A CLI/Core version mismatch prints a warning.

---

## `kodo help`

```bash
kodo help
kodo help run
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | The agent ran and the task did not succeed. |
| `2` | Invalid usage — unknown command, bad flag, missing argument. |
| `3` | Configuration problem — no model configured, unreadable config, failed doctor check. |
| `4` | Provider rejected the request — missing, invalid or unauthorised API key. |
| `5` | A permission or security boundary refused the action — a non-loopback bind without `--yes-i-know`, a sandbox that could not be verified. |
| `6` | Runtime or server failure — a server would not start, stop, or become healthy. |

These are part of the public interface. `kodo run` in particular distinguishes
"the task failed" (1) from "you invoked me wrong" (2) from "your key is bad"
(4), so a script can tell them apart.

```bash
kodo run "fix the build" || case $? in
  1) echo "agent could not complete the task" ;;
  3) echo "configure Kodo first: kodo doctor" ;;
  4) echo "check your API key" ;;
esac
```
