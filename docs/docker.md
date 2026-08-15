# Docker sandbox

Run the agent inside a container instead of directly on your machine.

```bash
kodo run "upgrade the dependencies and fix the breakage" --sandbox docker
kodo chat --sandbox docker
```

## Prerequisites

- Docker installed and the **daemon running**. `docker info` must succeed —
  having the CLI on PATH is not enough, and this is the most common failure.
- Enough disk for the image (`node:22-bookworm-slim`, ~200 MB, pulled once).

Check what Kodo can actually use:

```bash
kodo doctor
```

```
  ✓ Sandboxes              host, docker (--sandbox)
  ✓ Docker                 Docker version 28.5.1
```

## First run

```bash
cd my-project
kodo run "run the test suite and fix what fails" --sandbox docker
```

```
  starting the docker sandbox…
  verifying isolation…
    ✓ processes execute in container a1b2c3d4e5f6
    ✓ isolated PID namespace (3 processes visible)
    ✓ file writes and reads execute inside the container
    ✓ the host filesystem layout is not visible inside the container
    ✓ no network access
  ✓ docker sandbox verified — files and processes are confined
```

The first run pulls the image, so it is slower.

## How the workspace is handled

Your workspace is bind-mounted at `/workspace` inside the container, so the
agent's edits land in your real project — that is the point.

**File operations still go through `docker exec`, not through the mount.**
Reading through the mount would "work" and would silently become a host escape
the moment anyone ran without one. Routing everything through `exec` means the
container's view *is* the runtime's view, by construction.

## Security model

The container Kodo starts:

| Setting | Why |
|---|---|
| `--network none` | An agent that cannot reach the network cannot exfiltrate the code it is reading. |
| `--cap-drop ALL` | No capabilities it does not need. |
| `--security-opt no-new-privileges` | No privilege escalation inside. |
| `--pids-limit 512` | A runaway build cannot fork-bomb the host. |
| `--memory 2g` | Bounded memory. |
| `--entrypoint sh` | Kodo needs a shell to exec into; an image with its own entrypoint would otherwise receive the keep-alive command as arguments. |

Kodo does **not** use `--privileged` and does **not** mount the Docker socket.
Mounting the socket would hand the agent control of the daemon — trivially
equivalent to root on the host, and it would make the sandbox meaningless.

## Choosing an image

```bash
KODO_DOCKER_IMAGE=python:3.12-slim kodo run "fix the tests" --sandbox docker
```

The image needs the toolchain your project uses. `git` must be present if you
use worktree-isolated sub-agents — the default Node image has it.

## Cleanup

The container is removed when the run finishes, including on failure and on
Ctrl+C. If a crash ever leaves one behind:

```bash
docker ps -a --filter "name=kodo-"
docker rm -f $(docker ps -aq --filter "name=kodo-")
```

Kodo names its containers `kodo-<random>`, so that filter never matches anything
of yours.

## What is and is not isolated

**Isolated:** every file read/write/edit/delete, glob, directory listing, grep,
shell command, background process, package install, git command, worktree, and
sub-agent.

**Not isolated:** undo snapshots (deliberately on the host — see
[sandboxing.md](./sandboxing.md)), configuration reads, session storage, and
model API calls (Kodo makes those, and the agent never holds your key).

**Refused:** host stdio MCP servers — see [mcp.md](./mcp.md).

## Failure behaviour

If Docker is unavailable, unhealthy, or isolation cannot be proven, the run
**does not start**:

```
error Could not start the docker sandbox: Docker is not available…
      Kodo will not run on the host when a sandbox was requested.
```

Exit code `5`. There is no fallback to the host — see
[sandboxing.md](./sandboxing.md#verification-is-empirical-and-failure-is-closed).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Docker is not available` | The daemon is not running. Start Docker Desktop, or `sudo systemctl start docker`. |
| Very slow first run | Pulling the image. `docker pull node:22-bookworm-slim` beforehand. |
| The agent cannot reach a package registry | `--network none` is the default. Pre-install dependencies, or run without the sandbox. |
| `needs git inside the sandbox` | Your image has no `git` and a sub-agent asked for worktree isolation. Use an image with git. |
| Permission errors on written files | The container writes as its own user. Check ownership in the bind-mounted workspace. |
