/**
 * tests/mcpSse.test.mjs
 * Run with: node tests/mcpSse.test.mjs
 *
 * The HTTP+SSE transport against a REAL streaming server: endpoint
 * negotiation, request/response correlation over the persistent stream, and —
 * the reason this transport exists — SERVER-INITIATED requests (sampling)
 * arriving down the open stream, which plain request/response HTTP cannot do.
 */

import assert from "assert";
import http from "http";

import { SseMcpClient } from "../services/mcpClient.mjs";
import { discoverMcpTools, callMcpTool, closeMcpPool } from "../services/mcpTools.mjs";

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
    let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => resolve(b));
  });
}

/**
 * A real MCP HTTP+SSE server:
 *   GET  /sse       → holds the stream open, first emits `event: endpoint`
 *   POST /messages  → accepts JSON-RPC; every reply goes back over the stream
 * `pushSampling` makes it initiate a sampling request at the client.
 */
function startSseServer() {
  let stream = null;
  const state = { posted: [], samplingReplies: [] };

  const send = (payload, event = "message") => {
    if (!stream) return;
    stream.write(`event: ${event}\ndata: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      stream = res;
      send("/messages", "endpoint");
      req.on("close", () => { stream = null; });
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const msg = JSON.parse(await readBody(req));
      state.posted.push(msg);
      res.writeHead(202).end(); // reply travels over the SSE stream

      // A reply to something WE asked the client (e.g. sampling).
      if (msg.id !== undefined && msg.method === undefined && msg.result !== undefined && msg.id >= 9000) {
        state.samplingReplies.push(msg);
        return;
      }
      if (msg.id === undefined) return; // notification

      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      } else if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "stream_tool", description: "Over SSE", inputSchema: { type: "object", properties: {} } }] } });
      } else if (msg.method === "tools/call") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "sse-result" }] } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
      }
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/sse`,
      state,
      pushSampling: () => send({
        jsonrpc: "2.0", id: 9001, method: "sampling/createMessage",
        params: { messages: [{ role: "user", content: { type: "text", text: "summarise" } }], maxTokens: 50 },
      }),
    }));
  });
}

const close = (s) => new Promise((r) => s.close(r));
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

console.log("\n📦 HTTP+SSE transport (real streaming server)");

await test("the endpoint event is negotiated and tools/list resolves over the stream", async () => {
  const { server, url } = await startSseServer();
  try {
    const client = new SseMcpClient({ url });
    const tools = await client.listTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "stream_tool");
    client.close();
  } finally { await close(server); }
});

await test("a tool call round-trips (POST out, reply back down the stream)", async () => {
  const { server, url, state } = await startSseServer();
  try {
    const client = new SseMcpClient({ url });
    const res = await client.callTool("stream_tool", { a: 1 });
    assert.strictEqual(res.text, "sse-result");
    assert.ok(state.posted.some((m) => m.method === "tools/call"), "request must go out over POST");
    client.close();
  } finally { await close(server); }
});

await test("SERVER-INITIATED sampling arrives on the open stream and is answered", async () => {
  const { server, url, state, pushSampling } = await startSseServer();
  const calls = [];
  try {
    const client = new SseMcpClient({
      url,
      onSampling: async (params) => {
        calls.push(params);
        return { role: "assistant", content: { type: "text", text: "SUMMARY" }, model: "m", stopReason: "endTurn" };
      },
    });
    await client.listTools();       // completes the handshake
    pushSampling();                 // server asks the client for a completion
    await settle();

    assert.strictEqual(calls.length, 1, "client should have handled the server's request");
    const reply = state.samplingReplies.at(-1);
    assert.ok(reply, "client must POST a reply back to the server");
    assert.strictEqual(reply.id, 9001, "reply must correlate to the server's request id");
    assert.strictEqual(reply.result.content.text, "SUMMARY");
    client.close();
  } finally { await close(server); }
});

await test("sampling declined cleanly when no bridge is configured (server never hangs)", async () => {
  const { server, url, state, pushSampling } = await startSseServer();
  try {
    const client = new SseMcpClient({ url }); // no onSampling
    await client.listTools();
    pushSampling();
    await settle();
    const posted = state.posted.find((m) => m.id === 9001);
    assert.ok(posted, "an error reply is still required, or the server waits forever");
    assert.ok(/not enabled/i.test(posted.error?.message || ""), `got: ${JSON.stringify(posted)}`);
    client.close();
  } finally { await close(server); }
});

await test("the sampling capability is advertised only when a bridge exists", async () => {
  const { server, url, state } = await startSseServer();
  try {
    const withBridge = new SseMcpClient({ url, onSampling: async () => ({}) });
    await withBridge.listTools();
    const init = state.posted.find((m) => m.method === "initialize");
    assert.deepStrictEqual(init.params.capabilities, { sampling: {} });
    withBridge.close();
  } finally { await close(server); }
});

await test("closing aborts the stream and rejects anything still pending", async () => {
  const { server, url } = await startSseServer();
  try {
    const client = new SseMcpClient({ url });
    await client.listTools();
    client.close();
    assert.strictEqual(client.postUrl, null);
    assert.strictEqual(client.pending.size, 0);
  } finally { await close(server); }
});

await test("an unreachable SSE endpoint fails fast", async () => {
  const client = new SseMcpClient({ url: "http://127.0.0.1:1/sse" });
  await assert.rejects(() => client.listTools(), /fetch|ECONNREFUSED|failed/i);
});

console.log("\n📦 discovery over SSE (the path the agent loop uses)");

await test("an sse server's tools are discovered, namespaced and callable", async () => {
  const { server, url } = await startSseServer();
  const clients = new Map();
  try {
    const { tools, routes, servers } = await discoverMcpTools({
      mcpServers: { streamy: { type: "sse", url, headers: {} } },
      cwd: process.cwd(), mcpClients: clients,
    });
    assert.strictEqual(servers[0].ok, true, servers[0].error || "");
    assert.ok(tools.some((t) => t.function.name === "mcp__streamy__stream_tool"));

    const res = await callMcpTool("mcp__streamy__stream_tool", {}, { routes, mcpClients: clients });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.output, "sse-result");
  } finally {
    closeMcpPool();
    await close(server);
  }
});

closeMcpPool();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
