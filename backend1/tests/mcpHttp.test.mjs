/**
 * tests/mcpHttp.test.mjs
 * Run with: node tests/mcpHttp.test.mjs
 *
 * Exercises the streamable-HTTP MCP transport against a REAL http.Server
 * speaking JSON-RPC — not a mocked fetch. Covers both reply encodings the
 * spec allows (application/json and text/event-stream), Mcp-Session-Id
 * round-tripping, error propagation, and end-to-end discovery/routing through
 * the same code path the agent loop uses.
 */

import assert from "assert";
import http from "http";

import { HttpMcpClient } from "../services/mcpClient.mjs";
import { discoverMcpTools, callMcpTool } from "../services/mcpTools.mjs";

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

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => { b += d; });
    req.on("end", () => resolve(b));
  });
}

/**
 * A real MCP server over HTTP.
 * @param {object} opts
 *   mode: "json" | "sse"       — how replies are encoded
 *   requireSession: boolean    — issue a session id and reject requests missing it
 *   requireAuth: string|null   — demand this exact Authorization header, else 401
 */
function startServer({ mode = "json", requireSession = false, requireAuth = null } = {}) {
  const seen = { sessionEchoes: [], authHeaders: [] };
  const SESSION = "sess-abc-123";

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const msg = body ? JSON.parse(body) : {};
    seen.authHeaders.push(req.headers.authorization || null);

    if (requireAuth && req.headers.authorization !== requireAuth) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Notifications carry no id and expect no body.
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }

    if (requireSession && msg.method !== "initialize") {
      seen.sessionEchoes.push(req.headers["mcp-session-id"] || null);
      if (req.headers["mcp-session-id"] !== SESSION) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "missing session" } }));
        return;
      }
    }

    let result;
    if (msg.method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "http-fixture", version: "1" } };
    } else if (msg.method === "tools/list") {
      result = { tools: [{ name: "ping", description: "Ping the remote", inputSchema: { type: "object", properties: { n: { type: "number" } } } }] };
    } else if (msg.method === "tools/call") {
      result = { content: [{ type: "text", text: `pong:${msg.params?.arguments?.n ?? "?"}` }] };
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } }));
      return;
    }

    const payload = { jsonrpc: "2.0", id: msg.id, result };
    const headers = { ...(requireSession && msg.method === "initialize" ? { "mcp-session-id": SESSION } : {}) };

    if (mode === "sse") {
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, seen, SESSION });
    });
  });
}

const close = (s) => new Promise((r) => s.close(r));

console.log("\n📦 streamable HTTP transport (real server)");

await test("application/json replies: initialize + tools/list over HTTP", async () => {
  const { server, url } = await startServer({ mode: "json" });
  try {
    const client = new HttpMcpClient({ url });
    const tools = await client.listTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "ping");
    client.close();
  } finally { await close(server); }
});

await test("text/event-stream replies are parsed (spec allows either encoding)", async () => {
  const { server, url } = await startServer({ mode: "sse" });
  try {
    const client = new HttpMcpClient({ url });
    const tools = await client.listTools();
    assert.strictEqual(tools[0].name, "ping", "SSE-framed JSON-RPC must be decoded");
    const res = await client.callTool("ping", { n: 7 });
    assert.strictEqual(res.text, "pong:7");
    client.close();
  } finally { await close(server); }
});

await test("Mcp-Session-Id issued on initialize is echoed on every later request", async () => {
  const { server, url, seen, SESSION } = await startServer({ mode: "json", requireSession: true });
  try {
    const client = new HttpMcpClient({ url });
    const tools = await client.listTools();
    assert.strictEqual(tools[0].name, "ping", "session-gated request should have succeeded");
    assert.ok(seen.sessionEchoes.length > 0, "server should have seen post-init requests");
    assert.ok(seen.sessionEchoes.every((s) => s === SESSION), `expected all echoes to be ${SESSION}, got ${seen.sessionEchoes}`);
    client.close();
  } finally { await close(server); }
});

await test("static auth headers are sent on every request", async () => {
  const { server, url, seen } = await startServer({ mode: "json", requireAuth: "Bearer tok-123" });
  try {
    const client = new HttpMcpClient({ url, headers: { Authorization: "Bearer tok-123" } });
    const tools = await client.listTools();
    assert.strictEqual(tools[0].name, "ping");
    assert.ok(seen.authHeaders.every((h) => h === "Bearer tok-123"));
    client.close();
  } finally { await close(server); }
});

await test("a 401 surfaces as a clear error rather than a silent empty tool list", async () => {
  const { server, url } = await startServer({ mode: "json", requireAuth: "Bearer right" });
  try {
    const client = new HttpMcpClient({ url, headers: { Authorization: "Bearer wrong" } });
    await assert.rejects(() => client.listTools(), /401/);
    client.close();
  } finally { await close(server); }
});

await test("a JSON-RPC error reply propagates its message", async () => {
  const { server, url } = await startServer({ mode: "json" });
  try {
    const client = new HttpMcpClient({ url });
    await client.start();
    // The fixture answers an unknown method with a JSON-RPC error object
    // (HTTP 200) — the client must surface its message, not swallow it.
    await assert.rejects(() => client._request("bogus/method", {}), /no such method/);
    client.close();
  } finally { await close(server); }
});

await test("an unreachable host fails fast with a useful message", async () => {
  const client = new HttpMcpClient({ url: "http://127.0.0.1:1/mcp" });
  await assert.rejects(() => client.listTools(), /failed|ECONNREFUSED|fetch/i);
});

console.log("\n📦 discovery + routing over HTTP (same path the agent loop uses)");

await test("an http server's tools are discovered, namespaced and callable", async () => {
  const { server, url } = await startServer({ mode: "json" });
  const clients = new Map();
  try {
    const mcpServers = { remote: { type: "http", url, headers: {} } };
    const { tools, routes, servers } = await discoverMcpTools({ mcpServers, cwd: process.cwd(), mcpClients: clients });

    assert.strictEqual(servers[0].ok, true, servers[0].error || "");
    assert.ok(tools.some((t) => t.function.name === "mcp__remote__ping"), "remote tool must be namespaced");

    const res = await callMcpTool("mcp__remote__ping", { n: 42 }, { routes, mcpClients: clients });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.output, "pong:42");
  } finally {
    for (const c of clients.values()) c.close();
    await close(server);
  }
});

await test("a dead http server is skipped while a healthy one still loads", async () => {
  const { server, url } = await startServer({ mode: "json" });
  const clients = new Map();
  try {
    const { tools, servers } = await discoverMcpTools({
      mcpServers: {
        good: { type: "http", url, headers: {} },
        dead: { type: "http", url: "http://127.0.0.1:1/mcp", headers: {} },
      },
      cwd: process.cwd(),
      mcpClients: clients,
    });
    assert.strictEqual(servers.find((s) => s.name === "dead").ok, false);
    assert.ok(tools.some((t) => t.function.name === "mcp__good__ping"));
  } finally {
    for (const c of clients.values()) c.close();
    await close(server);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
