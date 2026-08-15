# Troubleshooting

Start here:

```bash
kodo doctor
```

It checks the installation, configuration, provider connectivity, MCP servers,
git, workspace, server state and available sandboxes — and never prints secrets.

---

## `kodo: command not found`

**Means:** the launcher is not on your PATH.

**Diagnose:**
```bash
ls ~/.local/bin/kodo && echo "$PATH" | tr ':' '\n' | grep -c '.local/bin'
```

**Fix:** add the directory to your PATH and restart your shell:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
```

If the file does not exist at all, re-run `sh install.sh`.

---

## `No model is configured` (exit 3)

**Means:** Kodo does not know which model to call.

**Fix:**
```bash
kodo config set model gpt-4.1-nano
kodo config list
```

---

## `No API key is configured` (exit 4)

**Means:** no credential in `~/.kodo/config.json` or the environment.

**Fix:**
```bash
kodo config set apiKey sk-your-key
```

Kodo deliberately will **not** fall back to another account's saved key.

---

## `The model provider rejected the request` (exit 4)

**Means:** the key reached the provider and was refused.

**Diagnose:**
```bash
kodo doctor      # look at "API connection"
kodo config list # confirm which baseUrl is in effect
```

**Most common cause:** a key for one provider being sent to another. A GapGPT or
OpenRouter key sent to `api.openai.com` returns exactly this. Make sure `baseUrl`
matches where the key is from:

```bash
kodo config set baseUrl https://api.gapgpt.app/v1
```

---

## `Port 9000 is already in use` / `Port 4173 is already in use`

**Means:** something already holds an explicitly-requested port.

**Diagnose:**
```bash
lsof -ti tcp:9000 -sTCP:LISTEN | xargs ps -p
```

**Fix:** let Kodo pick, or stop the other process:
```bash
kodo ui start --port 0 --api-port 0
```

Note the *default* API port is not treated as a request — if 9000 is busy Kodo
moves to a free port automatically.

---

## `Kodo ui is already running`

**Fix:**
```bash
kodo ui status     # where it is
kodo ui restart    # replace it
kodo ui stop       # stop it
```

---

## "cleared a stale runtime record left by a previous crash"

**Means:** a server died without cleaning up; Kodo noticed the PID is dead and
reclaimed the record. Harmless — you do not need to do anything.

---

## "A runtime record existed but the process it named is not Kodo"

**Means:** the PID in the state file now belongs to something else (the OS
recycled it). Kodo **did not signal it** and cleared the record instead.

This is the protection working. Just start again.

---

## `did not become healthy within 30s` (exit 6)

**Diagnose:**
```bash
cat "$(kodo ui logs)"
```

**Most common cause:** the Next.js UI has no production build.
```bash
npm --prefix chatbot/my-chatbot-ui run build
```

---

## UI production build fails

**`useSearchParams() should be wrapped in a suspense boundary`** — a page reads
the query string without a Suspense boundary, which Next refuses to prerender.
Wrap the component:

```tsx
export default function Page() {
  return <Suspense fallback={<div />}><Inner /></Suspense>;
}
```

**`ENOENT: prerender-manifest.json`** — you have a *development* `.next`, not a
production build. Run `npm run build`.

---

## `Could not start the docker sandbox` (exit 5)

**Means:** Docker is not usable. Kodo did **not** fall back to your host.

**Diagnose:**
```bash
docker info
```

**Fix:** start the daemon (Docker Desktop, or `sudo systemctl start docker`).
Then `kodo doctor` should list `docker` under Sandboxes.

---

## `Could not start the incus sandbox` (exit 5)

Same shape. `incus info` must succeed. Incus is Linux-only, and this runtime is
**not yet verified against a live daemon** — see [incus.md](./incus.md).

---

## `The docker sandbox could not prove isolation` (exit 5)

**Means:** the container started but an isolation check failed, so Kodo refused
to run.

This is intentional and rare. It usually indicates an unusual Docker setup
(a shared PID namespace, a remote daemon with a surprising mount layout). Run
without `--sandbox` only if you accept host execution.

---

## `isolation: worktree needs git inside the sandbox`

**Means:** a sub-agent asked for worktree isolation and your sandbox image has
no `git`.

**Fix:** use an image that includes it (the default Node image does):
```bash
KODO_DOCKER_IMAGE=node:22-bookworm-slim kodo run "..." --sandbox docker
```

---

## MCP servers are missing under a sandbox

**Means:** working as designed. Host stdio MCP servers are refused under a
sandbox because they would bypass it entirely. See [mcp.md](./mcp.md).

`/mcp` shows them with the reason. Override per server with
`"allowHostAccessInSandbox": true`, understanding what it gives up.

---

## An MCP server shows as unavailable

**Diagnose:** run `/mcp` — it connects, rather than re-reading config.

**Most common cause:** the server is declared but not installed. Try its command
by hand:
```bash
npx @playwright/mcp --headless
```

---

## `command blocked` / `is not in the allowed list`

**Means:** the bash allowlist refused a command.

**Fix:** grant it deliberately in `.kodo/settings.json`:
```json
{ "permissions": { "allow": ["Bash(pytest:*)"] } }
```

Note `node -e` and other inline-eval forms are blocked outright — they run
arbitrary code and would sidestep the allowlist. Write a file and run it.

---

## `Reading .env is blocked`

**Means:** the sensitive-file protection working. Kodo will not load credential
files into the model's context. This is not configurable.

---

## The agent says it verified something it did not

Kodo detects unbacked verification claims and corrects them. If you want a real
gate, declare a Stop hook so the project itself defines "verified":

```json
{ "hooks": { "stop": "npm test" } }
```

---

## Still stuck

```bash
kodo doctor --json          # full machine-readable report
kodo status --json          # runtime state
kodo --debug <command>      # stack traces
cat "$(kodo ui logs)"       # server logs
```

`kodo doctor --json` is safe to share — it contains no credentials.
