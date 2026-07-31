/**
 * tests/mcpPromptCommand.test.mjs
 * Run with: node tests/mcpPromptCommand.test.mjs
 *
 * The /mcp__<server>__<prompt> command surface: recognition, argument
 * parsing, and end-to-end expansion against a REAL stdio MCP server that
 * serves prompts.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";

import {
  isMcpPromptCommand, parseMcpPromptCommand, expandMcpPromptCommand,
} from "../routes/plannerAgent.mjs";
import { closeMcpPool } from "../services/mcpTools.mjs";

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
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
    else if (msg.method === "prompts/list") send({ jsonrpc: "2.0", id: msg.id, result: { prompts: [
      { name: "review", description: "Review a diff", arguments: [{ name: "area", required: false }] },
    ] } });
    else if (msg.method === "prompts/get") {
      if (msg.params.name !== "review") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown prompt" } });
      else send({ jsonrpc: "2.0", id: msg.id, result: { description: "Review a diff", messages: [
        { role: "user", content: { type: "text", text: "Perform a code review. Area: " + ((msg.params.arguments && msg.params.arguments.area) || "all") } },
      ] } });
    }
    else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  }
});
`;

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-prompt-cmd-"));
const serverPath = path.join(workspace, "prompt-server.mjs");
await fs.writeFile(serverPath, SERVER_SRC, "utf-8");
await fs.mkdir(path.join(workspace, ".kodo"), { recursive: true });
await fs.writeFile(
  path.join(workspace, ".kodo", "settings.json"),
  JSON.stringify({ mcpServers: { docs: { command: process.execPath, args: [serverPath] } } }, null, 2),
  "utf-8",
);

console.log("\n📦 command recognition + parsing");

await test("only /mcp__server__prompt shapes are recognised", () => {
  assert.ok(isMcpPromptCommand("/mcp__docs__review"));
  assert.ok(isMcpPromptCommand("/mcp__docs__review area=auth"));
  assert.ok(!isMcpPromptCommand("/mcp"), "the /mcp listing command is not a prompt");
  assert.ok(!isMcpPromptCommand("/help"));
  assert.ok(!isMcpPromptCommand("just a normal message"));
});

await test("server and prompt names are split correctly", () => {
  const p = parseMcpPromptCommand("/mcp__docs__review");
  assert.strictEqual(p.serverName, "docs");
  assert.strictEqual(p.promptName, "review");
  assert.deepStrictEqual(p.args, {});
});

await test("key=value arguments are parsed, including quoted values", () => {
  const p = parseMcpPromptCommand(`/mcp__docs__review area=auth title="the login flow" n=3`);
  assert.deepStrictEqual(p.args, { area: "auth", title: "the login flow", n: "3" });
});

await test("free text after the command is kept as trailing context", () => {
  const p = parseMcpPromptCommand("/mcp__docs__review area=auth focus on token expiry");
  assert.strictEqual(p.args.area, "auth");
  assert.strictEqual(p.trailing, "focus on token expiry");
});

console.log("\n📦 expansion against a real MCP server");

await test("a prompt expands into the turn's instruction text", async () => {
  const out = await expandMcpPromptCommand("/mcp__docs__review area=auth", workspace);
  assert.strictEqual(out.ok, true, out.error);
  assert.ok(/Perform a code review\. Area: auth/.test(out.text), `got: ${out.text}`);
});

await test("omitted arguments fall back to the server's own default", async () => {
  const out = await expandMcpPromptCommand("/mcp__docs__review", workspace);
  assert.strictEqual(out.ok, true, out.error);
  assert.ok(/Area: all/.test(out.text), `got: ${out.text}`);
});

await test("trailing free text is appended to the expanded prompt", async () => {
  const out = await expandMcpPromptCommand("/mcp__docs__review area=auth check token expiry", workspace);
  assert.strictEqual(out.ok, true, out.error);
  assert.ok(/Area: auth/.test(out.text));
  assert.ok(/check token expiry/.test(out.text), "user's extra instruction must survive");
});

await test("an unknown prompt reports what IS available", async () => {
  const out = await expandMcpPromptCommand("/mcp__docs__nope", workspace);
  assert.strictEqual(out.ok, false);
  assert.ok(/\/mcp__docs__review/.test(out.error), `should list real prompts; got: ${out.error}`);
});

await test("an unknown server fails with a pointer to /mcp", async () => {
  const out = await expandMcpPromptCommand("/mcp__ghost__review", workspace);
  assert.strictEqual(out.ok, false);
  assert.ok(/No MCP server named "ghost"/.test(out.error));
});

closeMcpPool();
await fs.rm(workspace, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
