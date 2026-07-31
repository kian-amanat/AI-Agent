/**
 * tests/mcpTools.test.mjs
 * Run with: node tests/mcpTools.test.mjs
 *
 * Covers the MCP integration end to end against a REAL stdio MCP server
 * (spawned from the fixture below — no mocks of the protocol itself), plus the
 * config normalising and permission rules that gate it.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { fileURLToPath } from "url";

import {
  discoverMcpTools, callMcpTool, isMcpToolName, mcpToolName,
  closeMcpPool, mcpPoolSize, isPooledClient,
  listMcpResources, readMcpResource, listMcpPrompts, getMcpPrompt,
} from "../services/mcpTools.mjs";
import {
  normalizeMcpServers, mcpToolDenied, mcpToolNeedsApproval,
} from "../agents/nodes/agent_loop.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── A real, minimal MCP server over stdio ────────────────────────────────────
// Speaks newline-delimited JSON-RPC exactly like a production server, so
// discovery//routing are exercised against the actual protocol.
const SERVER_SRC = `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "boom", description: "Always fails" },
      ] } });
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params;
      if (name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (args && args.text) }] } });
      else send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "tool exploded" }], isError: true } });
    } else if (msg.method === "resources/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { resources: [
        { uri: "mem://notes", name: "Notes", description: "Project notes", mimeType: "text/plain" },
        { uri: "mem://logo", name: "Logo", mimeType: "image/png" },
      ] } });
    } else if (msg.method === "resources/read") {
      const uri = msg.params.uri;
      if (uri === "mem://notes") send({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri, mimeType: "text/plain", text: "ship on friday" }] } });
      else if (uri === "mem://logo") send({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri, mimeType: "image/png", blob: "AAAA".repeat(64) }] } });
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "no such resource" } });
    } else if (msg.method === "prompts/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { prompts: [
        { name: "review", description: "Review a diff", arguments: [{ name: "diff", required: true }] },
      ] } });
    } else if (msg.method === "prompts/get") {
      if (msg.params.name !== "review") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown prompt" } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { description: "Review a diff", messages: [
          { role: "user", content: { type: "text", text: "Review this: " + (msg.params.arguments && msg.params.arguments.diff) } },
        ] } });
      }
    } else if (msg.method === "startSampling") {
      // Fixture-only trigger: makes the server initiate a sampling request
      // back at the client, which is the direction that matters here.
      send({ jsonrpc: "2.0", id: 9001, method: "sampling/createMessage", params: {
        messages: [{ role: "user", content: { type: "text", text: "summarise this" } }],
        maxTokens: 100,
      } });
      send({ jsonrpc: "2.0", id: msg.id, result: { started: true } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
    }
  }
});
`;

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-mcp-test-"));
const serverPath = path.join(tmpDir, "fixture-server.mjs");
await fs.writeFile(serverPath, SERVER_SRC, "utf-8");

const goodServer = { fixture: { type: "stdio", command: process.execPath, args: [serverPath], env: {} } };

console.log("\n📦 normalizeMcpServers (Claude Code config shapes)");

await test("stdio shape (command/args/env) is accepted", () => {
  const out = normalizeMcpServers({ p: { command: "npx", args: ["@playwright/mcp"], env: { A: "1" } } });
  assert.deepStrictEqual(out.p, { type: "stdio", command: "npx", args: ["@playwright/mcp"], env: { A: "1" } });
});

await test("remote http shape (type/url/headers) is accepted", () => {
  const out = normalizeMcpServers({ r: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } } });
  assert.deepStrictEqual(out.r, { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } });
});

await test("sse shape is accepted as a remote transport", () => {
  const out = normalizeMcpServers({ s: { type: "sse", url: "https://x/sse" } });
  assert.strictEqual(out.s.type, "sse");
});

await test("malformed entries are dropped without taking down valid ones", () => {
  const out = normalizeMcpServers({ bad: { nonsense: true }, alsoBad: null, good: { command: "ls" } });
  assert.deepStrictEqual(Object.keys(out), ["good"]);
});

console.log("\n📦 discovery + routing (against a real stdio MCP server)");

await test("tools are discovered and namespaced mcp__<server>__<tool>", async () => {
  const clients = new Map();
  try {
    const { tools, routes, servers } = await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    assert.strictEqual(servers[0].ok, true, servers[0].error || "");
    assert.strictEqual(servers[0].toolCount, 2);
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes("mcp__fixture__echo"), `got ${names.join(",")}`);
    assert.ok(routes.get("mcp__fixture__echo").toolName === "echo");
  } finally {
    closeMcpPool();
  }
});

await test("the server's JSON Schema is passed through as the tool's parameters", async () => {
  const clients = new Map();
  try {
    const { tools } = await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const echo = tools.find((t) => t.function.name === "mcp__fixture__echo");
    assert.strictEqual(echo.function.parameters.properties.text.type, "string");
    assert.ok(/\[MCP: fixture\]/.test(echo.function.description), "description should name the origin server");
  } finally {
    closeMcpPool();
  }
});

await test("a tool with NO inputSchema still gets a valid object schema", async () => {
  const clients = new Map();
  try {
    const { tools } = await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const boom = tools.find((t) => t.function.name === "mcp__fixture__boom");
    assert.strictEqual(boom.function.parameters.type, "object");
  } finally {
    closeMcpPool();
  }
});

await test("calling a discovered tool routes to the server and returns its output", async () => {
  const clients = new Map();
  try {
    const { routes } = await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const res = await callMcpTool("mcp__fixture__echo", { text: "hi" }, { routes, mcpClients: clients });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.output, "echo:hi");
  } finally {
    closeMcpPool();
  }
});

await test("a server-reported tool error (isError) becomes a failed tool result", async () => {
  const clients = new Map();
  try {
    const { routes } = await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const res = await callMcpTool("mcp__fixture__boom", {}, { routes, mcpClients: clients });
    assert.strictEqual(res.success, false);
    assert.ok(/exploded/.test(res.error));
  } finally {
    closeMcpPool();
  }
});

await test("an UNAVAILABLE server is skipped, and working servers still load", async () => {
  const clients = new Map();
  try {
    const { tools, servers } = await discoverMcpTools({
      mcpServers: {
        ...goodServer,
        broken: { type: "stdio", command: process.execPath, args: [path.join(tmpDir, "does-not-exist.mjs")], env: {} },
      },
      cwd: tmpDir,
      mcpClients: clients,
    });
    const broken = servers.find((s) => s.name === "broken");
    assert.strictEqual(broken.ok, false, "broken server must be reported as failed");
    assert.ok(tools.some((t) => t.function.name === "mcp__fixture__echo"), "healthy server's tools must still load");
  } finally {
    closeMcpPool();
  }
});

await test("no configured servers → no work, no tools", async () => {
  const out = await discoverMcpTools({ mcpServers: {}, cwd: tmpDir, mcpClients: new Map() });
  assert.deepStrictEqual(out.tools, []);
  assert.deepStrictEqual(out.servers, []);
});

await test("calling an unrouted tool fails cleanly instead of throwing", async () => {
  const res = await callMcpTool("mcp__ghost__nope", {}, { routes: new Map(), mcpClients: new Map() });
  assert.strictEqual(res.success, false);
  assert.ok(/Unknown MCP tool/.test(res.error));
});

console.log("\n📦 name helpers + permission rules");

await test("isMcpToolName only matches namespaced MCP tools", () => {
  assert.ok(isMcpToolName("mcp__github__create_issue"));
  assert.ok(!isMcpToolName("read_file"));
  assert.strictEqual(mcpToolName("github", "create_issue"), "mcp__github__create_issue");
});

await test("deny blocks a whole server or a single tool", () => {
  assert.ok(mcpToolDenied("mcp__github__delete_repo", { deny: ["mcp__github__delete_repo"] }));
  assert.ok(mcpToolDenied("mcp__github__delete_repo", { deny: ["mcp__github"] }), "server-level rule should cover its tools");
  assert.ok(!mcpToolDenied("mcp__slack__post", { deny: ["mcp__github"] }));
});

await test("ask triggers approval unless a matching allow cancels it", () => {
  assert.ok(mcpToolNeedsApproval("mcp__github__create_pr", { ask: ["mcp__github"] }));
  assert.ok(!mcpToolNeedsApproval("mcp__github__create_pr", { ask: ["mcp__github"], allow: ["mcp__github__create_pr"] }));
  assert.ok(!mcpToolNeedsApproval("mcp__github__create_pr", {}), "no ask rules → never pause");
});

await test("a server-name prefix does not leak across similarly named servers", () => {
  assert.ok(!mcpToolDenied("mcp__github_enterprise__push", { deny: ["mcp__github"] }));
});

console.log("\n📦 resources");

await test("resources are listed across connected servers", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const resources = await listMcpResources(clients);
    assert.strictEqual(resources.length, 2);
    assert.strictEqual(resources[0].uri, "mem://notes");
    assert.strictEqual(resources[0].serverName, "fixture");
  } finally { closeMcpPool(); }
});

await test("a text resource is read and returned", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const res = await readMcpResource("mem://notes", { mcpClients: clients });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.output, "ship on friday");
  } finally { closeMcpPool(); }
});

await test("a BINARY resource is described, not dumped as base64 into context", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const res = await readMcpResource("mem://logo", { mcpClients: clients });
    assert.strictEqual(res.success, true, res.error);
    assert.ok(/binary resource image\/png/.test(res.output), `got: ${res.output.slice(0, 80)}`);
    assert.ok(!/AAAAAAAA/.test(res.output), "base64 payload must not be inlined");
  } finally { closeMcpPool(); }
});

await test("an unknown resource URI fails cleanly", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const res = await readMcpResource("mem://nope", { mcpClients: clients });
    assert.strictEqual(res.success, false);
  } finally { closeMcpPool(); }
});

console.log("\n📦 prompts");

await test("prompts are listed with Claude Code's /mcp__server__prompt naming", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const prompts = await listMcpPrompts(clients);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].command, "/mcp__fixture__review");
    assert.strictEqual(prompts[0].arguments[0].name, "diff");
  } finally { closeMcpPool(); }
});

await test("a prompt expands to text with its arguments substituted", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const res = await getMcpPrompt("fixture", "review", { diff: "+1 -1" }, { mcpClients: clients });
    assert.strictEqual(res.success, true, res.error);
    assert.ok(/Review this: \+1 -1/.test(res.text), `got: ${res.text}`);
  } finally { closeMcpPool(); }
});

await test("an unknown prompt fails cleanly", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    const res = await getMcpPrompt("fixture", "ghost", {}, { mcpClients: clients });
    assert.strictEqual(res.success, false);
  } finally { closeMcpPool(); }
});

console.log("\n📦 sampling (server → client completion)");

await test("a server's sampling/createMessage is answered by our LLM bridge", async () => {
  const clients = new Map();
  const calls = [];
  // Stand-in for chatWithTools: records what the bridge asked for.
  const chat = async ({ messages, maxTokens }) => {
    calls.push({ messages, maxTokens });
    return { message: { content: "SUMMARY" } };
  };
  try {
    await discoverMcpTools({
      mcpServers: goodServer, cwd: tmpDir, mcpClients: clients,
      sampling: { chat, creds: { apiKey: "k", model: "test-model" } },
    });
    const client = clients.get("fixture");
    await client._request("startSampling", {});
    // The server pushes its request asynchronously; give the read loop a tick.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(calls.length, 1, "the bridge should have run one completion");
    assert.strictEqual(calls[0].messages[0].content, "summarise this");
  } finally { closeMcpPool(); }
});

await test("sampling is capped so a server cannot request unbounded generation", async () => {
  const clients = new Map();
  const calls = [];
  const chat = async (a) => { calls.push(a); return { message: { content: "x" } }; };
  try {
    await discoverMcpTools({
      mcpServers: goodServer, cwd: tmpDir, mcpClients: clients,
      sampling: { chat, creds: { apiKey: "k", model: "m" } },
    });
    const client = clients.get("fixture");
    // Drive the handler directly with an absurd maxTokens.
    const result = await client.onSampling({ messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10_000_000 });
    assert.ok(calls[0].maxTokens <= 2000, `expected cap, got ${calls[0].maxTokens}`);
    assert.strictEqual(result.content.text, "x");
    assert.strictEqual(result.role, "assistant");
  } finally { closeMcpPool(); }
});

await test("with no sampling bridge configured, the capability is not advertised", async () => {
  const clients = new Map();
  try {
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: clients });
    assert.strictEqual(clients.get("fixture").onSampling, null);
  } finally { closeMcpPool(); }
});

console.log("\n📦 cross-run connection reuse");

await test("a second run reuses the pooled client instead of respawning", async () => {
  try {
    const a = new Map();
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: a });
    const first = a.get("fixture");
    assert.ok(isPooledClient(first), "discovery-created clients must be pooled");
    assert.strictEqual(mcpPoolSize(), 1);

    const b = new Map(); // a fresh run: new ctx.mcpClients map
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: b });
    assert.strictEqual(b.get("fixture"), first, "the same client instance must be reused");
    assert.strictEqual(mcpPoolSize(), 1, "reuse must not grow the pool");
  } finally { closeMcpPool(); }
});

await test("changing a server's config yields a NEW connection, not a stale one", async () => {
  try {
    const a = new Map();
    await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: a });
    const first = a.get("fixture");

    const changed = { fixture: { ...goodServer.fixture, env: { CHANGED: "1" } } };
    const b = new Map();
    await discoverMcpTools({ mcpServers: changed, cwd: tmpDir, mcpClients: b });
    assert.notStrictEqual(b.get("fixture"), first, "edited config must not reuse the old client");
    assert.strictEqual(mcpPoolSize(), 2);
  } finally { closeMcpPool(); }
});

await test("a failed server is evicted so the next run retries cleanly", async () => {
  try {
    const bad = { flaky: { type: "stdio", command: process.execPath, args: [path.join(tmpDir, "gone.mjs")], env: {} } };
    await discoverMcpTools({ mcpServers: bad, cwd: tmpDir, mcpClients: new Map() });
    assert.strictEqual(mcpPoolSize(), 0, "a broken client must not stay pooled");
  } finally { closeMcpPool(); }
});

await test("closeMcpPool tears everything down", async () => {
  await discoverMcpTools({ mcpServers: goodServer, cwd: tmpDir, mcpClients: new Map() });
  assert.ok(mcpPoolSize() >= 1);
  closeMcpPool();
  assert.strictEqual(mcpPoolSize(), 0);
});

closeMcpPool();
await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
