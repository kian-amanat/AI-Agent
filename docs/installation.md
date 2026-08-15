# Installing Kodo

Kodo is an AI coding agent you run from your terminal. It edits files, runs
commands, and can work inside a container sandbox.

## Install

```bash
npm install -g kodo-agent
```

Verify:

```bash
kodo --version
```

Diagnose:

```bash
kodo doctor
```

Same command on **macOS**, **Linux** and **Windows**:

| Platform | Command |
|---|---|
| macOS | `npm install -g kodo-agent` |
| Linux | `npm install -g kodo-agent` |
| Windows (PowerShell) | `npm install -g kodo-agent` |

### Why the package is called `kodo-agent`

The command you type is `kodo`. The npm package is `kodo-agent` because `kodo`
on npm is an unrelated MVC framework from 2013 and `kodo-cli` is a status-page
tool — neither is available. The binary name is unaffected.

### One-off use, without installing

```bash
npx kodo-agent --version
npx kodo-agent doctor
```

### In a project, for a team or CI

```bash
npm install --save-dev kodo-agent
npx kodo run "check the build"
```

## Start Kodo

```bash
cd your-project
kodo
```

## Start the web UI

```bash
kodo ui start
```

## Update Kodo

```bash
kodo update
```

It detects that npm owns the installation and runs
`npm install -g kodo-agent@latest` for you. Your configuration in `~/.kodo` is
never touched.

## Remove Kodo

```bash
npm uninstall -g kodo-agent
```

`kodo uninstall` explains this and can optionally remove Kodo's own data
(`--cache`, `--config`) — it never deletes npm-managed files or your projects.

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Node.js 20.12 or newer** | Kodo is a Node application. 20.12 is the floor because it is where `process.loadEnvFile` and the `AbortSignal` behaviour Kodo relies on landed. Check with `node --version`. |
| **git** (recommended) | Kodo works without it, but you lose easy undo of the agent's edits. |
| **An API key** for an OpenAI-compatible provider | Kodo talks to a model. See [configuration.md](./configuration.md). |
| **Docker** (optional) | Only for `--sandbox docker`. See [docker.md](./docker.md). |
| **Incus** (optional) | Only for `--sandbox incus`. See [incus.md](./incus.md). |

## Supported platforms

Kodo installs the same way everywhere: `npm install -g kodo-agent`. npm resolves
dependencies — including the native `better-sqlite3` — for the platform it is
installing on, so there is no per-platform download to choose.

Status words mean what they say. **Verified** = executed there and passed.
**Not verified** = the code exists and was reviewed, but nobody has run it.

| Platform | npm install | CLI | Web UI | Docker sandbox | Status |
|---|---|---|---|---|---|
| macOS arm64 | Verified | Verified | Verified | Verified | **Supported** |
| macOS x64 | Not verified | Not verified | Not verified | Not verified | **Experimental** |
| Linux x64 | Not verified | Not verified | Not verified | Not verified | **Experimental** |
| Linux arm64 | Not verified | Not verified | Not verified | Not verified | **Experimental** |
| Windows x64 | Not verified | Not verified | Not verified | Not verified | **Experimental** |

Only **macOS arm64** has been run end to end: pack, `npm install -g` into a
clean prefix, then `--version`, `doctor`, `init`, `run`, `sessions`,
`ui start/status/stop`, `update` and `uninstall` — from an unrelated directory
with the repository moved away.

The other rows are Experimental because nobody has executed them, not because
anything is known to be wrong. Since the npm package is platform-independent —
no bundled binaries, dependencies resolved per machine — the main risk is
Windows, where the process layer (`netstat`/`tasklist`/`taskkill`) has never
been exercised. See [Windows](#windows).

Incus is implemented but **not advertised** as a sandbox; see
[docs/incus.md](./incus.md).

## Alternative installations

`npm install -g kodo-agent` above is the supported path. The two below exist for
specific situations — contributing to Kodo, or a machine with no npm — and are
**not** what a normal user needs.

### From source (contributors)

A source checkout with a working `kodo` on your PATH.

```bash
git clone <your-kodo-repo-url> kodo
cd kodo
npm --prefix backend1 install
sh install.sh
```

Then verify:

```bash
kodo --version
```

### What the installer does

1. Detects your OS and architecture.
2. Checks for Node.js 20.12+, and stops immediately if it is missing — before
   touching anything.
3. Confirms the checkout has `cli/bin/kodo.mjs` and that Kodo Core's
   dependencies are installed.
4. Writes a small launcher script to `~/.local/bin/kodo` that runs the CLI out
   of your checkout. It writes to a temp name and renames, so an interrupted
   install leaves your previous `kodo` working.
5. Tells you if `~/.local/bin` is not on your PATH, with the exact line to add
   for bash, zsh or fish.

It never uses `sudo`. It never touches `~/.kodo`, so your configuration
survives reinstalls by construction.

### Where things go

| Path | Contents |
|---|---|
| `~/.local/bin/kodo` | The launcher on your PATH. Override with `KODO_INSTALL_DIR`. |
| your checkout | The actual code. The launcher points here. |
| `~/.kodo/config.json` | Your configuration, including your API key. Mode `0600`. |
| `~/.kodo/runtime/` | Running server state (PID, port, token). |
| `~/.kodo/logs/` | Server logs, rotated. Never contains credentials. |
| `~/.kodo/sessions/` | Your CLI session transcripts. |

### Installer options

All are environment variables:

```bash
KODO_INSTALL_DIR="$HOME/bin" sh install.sh    # install the launcher elsewhere
KODO_SOURCE_DIR=/path/to/kodo sh install.sh   # install from a checkout elsewhere
```

### PATH

If `kodo --version` says `command not found`, the install directory is not on
your PATH. Add it:

```bash
# bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# zsh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc

# fish
fish_add_path ~/.local/bin
```

Then restart your shell.

## Configure a model

```bash
kodo config set model gpt-4.1-nano
kodo config set apiKey sk-your-key-here
kodo config set baseUrl https://api.openai.com/v1
```

Kodo never prints your key back. `kodo config get apiKey` shows a mask.

Confirm everything works:

```bash
kodo doctor
```

## First run

```bash
cd my-project
kodo init          # generates KODO.md by inspecting your repository
kodo               # interactive session
```

Or a single task:

```bash
kodo run "fix the failing tests"
```

## Updating

```bash
kodo update           # git pull + reinstall dependencies
kodo update --check   # report whether an update is available
```

`kodo update` refuses to run if your checkout has uncommitted changes — it will
not discard local work. Your `~/.kodo` configuration is never touched.

## Uninstalling

```bash
kodo uninstall              # removes the launcher only
kodo uninstall --cache      # also logs, runtime state and sessions
kodo uninstall --config     # also ~/.kodo/config.json, INCLUDING your API key
kodo uninstall --all        # everything above
```

Removing your configuration requires typing `remove` to confirm, because a
deleted API key cannot be recovered by reinstalling.

Kodo never deletes your projects, their `.kodo/` directories, or `KODO.md`.
The source checkout is left in place for you to delete yourself.

## About release hosting

`install.sh` also implements a full release-download path: OS/arch detection,
tarball download, SHA256 verification against a published `SHA256SUMS`, and an
atomic versioned-directory swap. It activates when `KODO_BASE_URL` is set:

```bash
KODO_BASE_URL=https://your-release-host sh install.sh
```

There is no default value, and there is no published release host. Documenting a
`curl … | sh` one-liner against a URL that serves nothing would give you a
command that fails with a 404 halfway through. When releases are published, that
one-liner becomes the recommended path and this page will say so.

## Windows

Windows x64 is **Experimental**: implemented, reviewed, and **not verified** —
no Windows machine was available to run it.

What exists:

| Piece | State |
|---|---|
| `install.ps1` | Written. Downloads, verifies SHA256, installs under `%LOCALAPPDATA%\Kodo`, adds it to the *user* PATH (no Administrator needed). **Never executed.** |
| Process identity / termination | Implemented natively in `cli/src/runtime/procinfo.mjs` using `netstat -ano`, `tasklist` and `taskkill /T` — all ship with Windows. No Git Bash, WSL or Cygwin required. **Never executed.** |
| CLI (`run`, `chat`, `doctor`) | Windows branches exist (`cmd.exe`, `where rg`, non-detached children). **Never executed.** |
| Release artifact | None. `kodo-<version>-win32-x64.tar.gz` must be built on a Windows machine, because the bundled native module is platform-specific. |

Installing on Windows, once an artifact exists:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -BaseUrl <your-release-host>
```

To promote Windows to Supported: build the artifact on Windows x64, run
`install.ps1`, then work through `docs/release-checklist.md` on that machine.
Until someone does, Kodo does not claim it works there.

