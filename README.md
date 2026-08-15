# Kodo

AI coding agent for your terminal, with a local web UI and real container
sandboxing.

## Install

```bash
npm install -g kodo-agent
```

Verify:

```bash
kodo --version
```

Requires **Node.js 20.12 or newer**. Same command on macOS, Linux and Windows.

> The npm package is `kodo-agent`; the command is `kodo`. The name `kodo` on npm
> is taken by an unrelated 2013 MVC framework.

## Use

```bash
cd my-project
kodo
```

That opens an interactive session in the current directory. For one-off work:

```bash
kodo run "fix the failing tests"
kodo run "add dark mode" --json     # JSON Lines, for scripts and CI
```

First time? Check your setup and configure a model:

```bash
kodo doctor
kodo config set model gpt-5
kodo config set apiKey sk-...
```

## Web UI

```bash
kodo ui start
```

Prints a URL and runs in the background. Also:

```bash
kodo ui status
kodo ui stop
```

Binds to `127.0.0.1` only. Exposing it to your network requires an explicit
flag, because it drives an agent that edits files and runs commands.

## Sandbox

Run the agent inside a container instead of directly on your machine:

```bash
kodo run --sandbox docker "upgrade the dependencies and fix the breakage"
```

Every filesystem operation and every process — not just `bash` — executes inside
the container. If isolation cannot be verified, Kodo **refuses to run** rather
than silently falling back to your host. See [docs/sandboxing.md](docs/sandboxing.md).

## Commands

```
kodo                    Interactive session in the current directory
kodo chat               Same, with options
kodo run "<task>"       One task, non-interactive. --json for JSON Lines.
kodo init               Set up Kodo in this project
kodo config             Read and write configuration
kodo status             What Kodo is doing right now
kodo doctor             Check that this installation works
kodo sessions           List past sessions
kodo resume <id>        Continue a session
kodo ui                 Manage the local web UI
kodo server             Manage the Local API
kodo update             Update Kodo
kodo uninstall          Remove Kodo
kodo completion         Shell completion
```

Full reference: [docs/cli.md](docs/cli.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Zero to your first agent run |
| [Installation](docs/installation.md) | npm, source, releases, platform matrix |
| [CLI reference](docs/cli.md) | Every command, option and exit code |
| [Configuration](docs/configuration.md) | Providers, models, precedence |
| [Web UI](docs/ui.md) | Lifecycle and security |
| [Sandboxing](docs/sandboxing.md) | What is isolated, and what is not |
| [Docker](docs/docker.md) | Container sandbox |
| [Incus](docs/incus.md) | Implemented, not yet verified |
| [MCP](docs/mcp.md) | Model Context Protocol, and its sandbox rules |
| [Permissions](docs/permissions.md) | Approval modes and command policy |
| [Sessions](docs/sessions.md) | History and resuming |
| [Troubleshooting](docs/troubleshooting.md) | When something goes wrong |
| [Architecture](docs/architecture.md) | How Kodo fits together |
| [Development](docs/development.md) | Building Kodo from source |

## Contributing

See [docs/development.md](docs/development.md) for building from source, running
the test suite and packaging a release.

## License

MIT — see [LICENSE](LICENSE).
