# MCP

Kodo connects to [Model Context Protocol](https://modelcontextprotocol.io)
servers declared in `{workspace}/.kodo/settings.json`. Their tools are offered
to the model as `mcp__<server>__<tool>`.

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp", "--headless"] },
    "remote":     { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

Inspect what actually came up — this connects, it does not just re-read config:

```
/mcp
```

`kodo doctor` reports the same thing.

## Security model

This is the part that matters, and it is not symmetrical between server types.

### stdio servers are HOST processes

A server declared with `command` is a child process on **your machine**, running
with **your privileges**, on **your filesystem**. Kodo speaks to it over stdio.

Many useful MCP servers — filesystem servers, shell servers, git servers — can
read and write files and execute commands. Kodo's own protections (path
confinement, the bash allowlist, sensitive-file blocking) apply to Kodo's tools.
**They do not apply inside an MCP server.** A filesystem MCP server rooted at
`/` can read your `~/.ssh` regardless of what Kodo would have allowed.

Grant them the way you would grant a shell: deliberately, per project.

### Under a sandbox, host MCP servers FAIL CLOSED

If a run is sandboxed (`--sandbox docker` / `--sandbox incus`), a stdio MCP
server is a complete bypass. The agent is confined; one `mcp__fs__write_file`
call reaches straight past the boundary onto the host.

So Kodo **refuses to start stdio MCP servers under a sandbox**. Their tools are
never offered to the model, and the refusal is reported rather than silent:

```
🔒 1 MCP server(s) not started — they run on the host and this run is sandboxed
```

`/mcp` and `kodo doctor` show them as not started, with the reason.

They cannot simply be moved inside the container: the server binary is installed
on your host and generally is not present in the sandbox image.

#### Overriding, per server

If you have a specific host server you trust and genuinely want available to a
sandboxed run:

```json
{
  "mcpServers": {
    "docs": {
      "command": "my-docs-server",
      "allowHostAccessInSandbox": true
    }
  }
}
```

Understand what this means: that server runs on the host with your privileges,
and the sandbox no longer contains everything the agent can reach through it.
It is per server and explicit — there is no global "disable this check".

### http/sse servers are NOT refused

A server declared with `type: "http"` or `type: "sse"` is a remote endpoint
reached over the network, not a host process. The process sandbox is not what
constrains it — its own authentication is. Kodo does not refuse these under a
sandbox.

Note that `--sandbox docker` defaults to `--network none`, so the *agent* cannot
reach the network; Kodo itself still can, and it is Kodo that talks to a remote
MCP server on the agent's behalf.

## What Kodo already protects

| Behaviour | Detail |
|---|---|
| Discovery is bounded | A hung server costs at most 15s and never blocks the tools the agent already has. |
| A broken server is skipped | Reported as unavailable; the run continues. |
| Sampling is capped | A server asking Kodo to run a completion is capped at 2000 tokens — a server must not spend your tokens without bound. |
| Elicitation is never auto-answered | A server asking the *user* for input goes through the interaction manager; unanswered requests time out as "cancel", the safe outcome. |
| Tool names are namespaced | `mcp__<server>__<tool>`, so two servers can both ship a `search`. |
| OAuth tokens are stored per server | Refreshed silently; a refresh produces a new client rather than reusing one pinned to a dead token. |

## Prompts and resources

A server's prompts are available as slash commands:

```
/mcp__github__review diff="a b" depth=2
```

These expand into your instruction for that turn. Resources are advertised, not
auto-injected — the model reads one with `read_mcp_resource` only if it wants
it, so they cost nothing otherwise.
