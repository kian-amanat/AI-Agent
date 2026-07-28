/**
 * tests/mcpClient.test.mjs
 * Run with: node tests/mcpClient.test.mjs
 *
 * Tests services/mcpClient.mjs against a tiny fake MCP server (plain
 * newline-delimited JSON-RPC over stdio, written to a temp file for the
 * duration of the run) — fast and offline. The real @playwright/mcp
 * integration is covered separately in tests/verifyUi.test.mjs.
 */

import assert from "assert";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { McpClient } from "../services/mcpClient.mjs";

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

const FAKE_SERVER = `
import readline from "readline";
const rl = readline.createInterface({ input: process.stdin });
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
function respondError(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { message } }) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    respond(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0.0.1" } });
  } else if (msg.method === "notifications/initialized") {
    // no response for notifications
  } else if (msg.method === "tools/list") {
    respond(msg.id, { tools: [{ name: "echo", description: "echoes input", inputSchema: {} }] });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo") respond(msg.id, { content: [{ type: "text", text: String(args?.text || "") }] });
    else if (name === "boom") respondError(msg.id, "boom tool always fails");
    else if (name === "slow") { /* never responds — used to test close() rejecting in-flight requests */ }
    else respondError(msg.id, "unknown tool " + name);
  }
});
`;

let fakeServerPath;

async function withClient(fn) {
  const client = new McpClient({ command: "node", args: [fakeServerPath] });
  try {
    await fn(client);
  } finally {
    client.close();
  }
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-mcp-test-"));
  fakeServerPath = path.join(dir, "fake_mcp_server.mjs");
  await fs.writeFile(fakeServerPath, FAKE_SERVER, "utf-8");

  console.log("\n📦 McpClient");

  await test("start() completes the initialize handshake", async () => {
    await withClient(async (client) => {
      const result = await client.start();
      assert.strictEqual(result.serverInfo.name, "fake");
    });
  });

  await test("listTools() returns the server's real tool list", async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      assert.strictEqual(tools.length, 1);
      assert.strictEqual(tools[0].name, "echo");
    });
  });

  await test("callTool() returns concatenated text content on success", async () => {
    await withClient(async (client) => {
      const res = await client.callTool("echo", { text: "hello mcp" });
      assert.strictEqual(res.text, "hello mcp");
      assert.strictEqual(res.isError, false);
    });
  });

  await test("callTool() rejects when the server returns a JSON-RPC error", async () => {
    await withClient(async (client) => {
      await assert.rejects(() => client.callTool("boom", {}), /boom tool always fails/);
    });
  });

  await test("close() rejects any in-flight request instead of hanging forever", async () => {
    const client = new McpClient({ command: "node", args: [fakeServerPath] });
    const pending = client.callTool("slow", {});
    await new Promise((r) => setTimeout(r, 200)); // let the request actually reach the fake server
    client.close();
    await assert.rejects(() => pending, /closed/i);
  });

  await test("a nonexistent command surfaces a clear error instead of hanging", async () => {
    const client = new McpClient({ command: "definitely-not-a-real-binary-xyz" });
    await assert.rejects(() => client.start());
    client.close();
  });

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${"─".repeat(40)}\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
