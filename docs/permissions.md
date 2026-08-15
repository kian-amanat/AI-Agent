# Permissions

Kodo can edit files and run shell commands. Several independent layers decide
what it is allowed to do, and they all still apply inside a sandbox.

## Permission modes

```bash
kodo chat --permission auto     # default
kodo chat --permission ask
kodo chat --permission plan
```

| Mode | Behaviour |
|---|---|
| `auto` | The agent proceeds under the workspace's permission rules. Dangerous and irreversible commands still pause for approval. |
| `ask` | Pauses before the first mutation and waits for you. |
| `plan` | Read-only. `edit_file`, `write_file` and mutating bash all refuse; the agent explores and presents a plan as text. |

Set a default per project in `.kodo/settings.json`:

```json
{ "kodo": { "permission": "ask" } }
```

## Workspace rules

```json
{
  "permissions": {
    "allow": ["Bash(pytest:*)", "Bash(docker compose:*)"],
    "ask":   ["Bash(git push:*)"],
    "deny":  ["Bash(rm:*)", "Bash(curl:*)"]
  }
}
```

**Deny always wins**, including over a hook that tries to auto-approve.

## The bash allowlist

Independently of your rules, the agent's shell tool has a baseline allowlist
(`node`, `npm`, `git`, `python3`, `ls`, `cat`, `grep`, `mkdir`, `mv`, `rm`,
`sed`, `awk`, and similar). Anything outside it is refused unless a workspace
`allow` rule grants it.

Two commands get special treatment:

- **`curl` is loopback-only** by default. It exists so the agent can verify a
  dev server it just started; reaching the public internet needs an explicit
  allow rule.
- **Inline evaluation is blocked** — `node -e`, `python -c`, `sh -c` and friends
  run arbitrary code and sidestep the allowlist entirely. The agent writes a
  file and runs it instead.

Paths outside the workspace (absolute, `~`, `..`) are refused.

To remove shell execution completely:

```bash
KODO_DISABLE_BASH=1 kodo run "..."
```

The agent can still read, edit, write, grep and search the web.

## Irreversible commands

Commands Kodo cannot undo — `git push --force`, destructive database commands,
production deploys — always pause for explicit approval, in every permission
mode, regardless of your rules. There is no inferred yes.

## Sensitive files

`.env`, credential files, private keys and similar are blocked from being read,
edited or created. A blocked path never even reaches the runtime.

This is why `kodo run` cannot exfiltrate your `.env` by "just reading a file".

## Undo

Every file the agent mutates is snapshotted before the first change in a
request, so a turn can be reverted. Snapshots live on the **host**, in
`~/.agent-history`, deliberately — if undo history lived inside a sandbox,
tearing the sandbox down would destroy your ability to revert.

## Hooks

A project can gate tool calls with its own commands:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "write_file",
        "hooks": [{ "type": "command", "command": "./scripts/check.sh" }] }
    ]
  }
}
```

A non-zero exit blocks the tool call. Inspect what is configured with `/hooks`.

Under a sandbox, `command` hooks run **inside the runtime**, not on your host —
they fire inside every tool call, so running them on the host would have meant a
confined run executing project shell on your machine hundreds of times per task.
Session-level hooks (`Setup`, `SessionStart`, `SessionEnd`) fire before a runtime
exists and remain host-side.

## Layer order

```
path confinement  →  sensitive-file block  →  permission mode  →
workspace rules  →  irreversible gate  →  PreToolUse hook  →  RUNTIME
```

A refusal at any layer means the operation never reaches a runtime at all.
