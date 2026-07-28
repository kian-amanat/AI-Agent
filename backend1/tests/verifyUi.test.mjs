/**
 * tests/verifyUi.test.mjs
 * Run with: node tests/verifyUi.test.mjs
 *
 * Integration test against the REAL @playwright/mcp server (spawned as a
 * child process, exactly as verify_ui does in production) and a real local
 * HTTP fixture server — no mocks for either side. Slower than the unit
 * suite (real browser launches) but this is exactly the path that matters:
 * MCP handshake, action batch, assertion evaluation, console/network
 * capture, and the vision-escalation gate all wired together for real.
 */

import assert from "assert";
import http from "http";
import os from "os";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { verifyUi } from "../agents/nodes/agent_loop.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_CLI = path.resolve(__dirname, "../node_modules/@playwright/mcp/cli.js");

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

const PAGES = {
  "/clean": `<!doctype html><html><body>
    <h1>Clean page</h1>
    <button id="counter-btn" onclick="document.getElementById('count').textContent = Number(document.getElementById('count').textContent) + 1">Increment</button>
    <span id="count">0</span>
  </body></html>`,
  "/broken-console": `<!doctype html><html><body><h1>Broken</h1>
    <script>console.error("something broke on load")</script>
  </body></html>`,
};

(async () => {
  const server = http.createServer((req, res) => {
    // A real browser always requests this; without a response Chromium logs
    // a 404 console error that has nothing to do with what these tests are
    // actually checking — same as any real dev server that serves a favicon.
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    const html = PAGES[req.url] || "<h1>404</h1>";
    res.writeHead(PAGES[req.url] ? 200 : 404, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = (p) => `http://localhost:${port}${p}`;

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-verifyui-"));
  const playwrightServerConfig = { command: "node", args: [MCP_CLI, "--headless", "--isolated", "--image-responses", "omit"] };

  function makeCtx(mcpServers) {
    return { root: workspaceRoot, mcpServers, mcpClients: new Map(), visionCreds: null };
  }

  console.log("\n📦 verify_ui");

  await test("returns a clear, actionable error when mcpServers.playwright isn't configured", async () => {
    const ctx = makeCtx({});
    const result = await verifyUi({ url: base("/clean") }, ctx);
    assert.strictEqual(result.success, false);
    assert.ok(/mcpServers/.test(result.error), `error should mention mcpServers config: ${result.error}`);
  });

  await test("rejects a non-loopback URL by default", async () => {
    const ctx = makeCtx({ playwright: playwrightServerConfig });
    const result = await verifyUi({ url: "https://example.com" }, ctx);
    assert.strictEqual(result.success, false);
    assert.ok(/loopback|127\.0\.0\.1/i.test(result.error));
  });

  const sharedCtx = makeCtx({ playwright: playwrightServerConfig });

  await test("a clean page passes the default (no_console_errors) assertion", async () => {
    const result = await verifyUi({ url: base("/clean") }, sharedCtx);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.console_errors_count, 0);
  });

  await test("reuses the same MCP client across calls instead of spawning a second browser", async () => {
    assert.strictEqual(sharedCtx.mcpClients.size, 1);
  });

  await test("a page with a real console.error fails no_console_errors with a non-zero count", async () => {
    const result = await verifyUi({ url: base("/broken-console") }, sharedCtx);
    assert.strictEqual(result.pass, false);
    assert.ok(result.console_errors_count >= 1);
  });

  await test("actions (click) actually mutate the page, and text_contains asserts the result", async () => {
    const result = await verifyUi({
      url: base("/clean"),
      actions: [{ type: "click", selector: "#counter-btn" }],
      assertions: [{ type: "text_contains", text: "1" }],
    }, sharedCtx);
    assert.strictEqual(result.actions_result[0].ok, true);
    assert.strictEqual(result.pass, true, JSON.stringify(result.assertions_result));
  });

  await test("a 'visible' assertion on a missing element fails, and with no console/network errors it's flagged as a silent failure (vision skipped — none configured in this test)", async () => {
    const result = await verifyUi({
      url: base("/clean"),
      assertions: [{ type: "visible", selector: "#does-not-exist" }],
    }, sharedCtx);
    assert.strictEqual(result.pass, false);
    assert.strictEqual(result.console_errors_count, 0);
    assert.ok(result.vision_unavailable_reason, "expected vision_unavailable_reason since ctx.visionCreds is null");
    assert.strictEqual(result.vision_summary, undefined);
  });

  for (const client of sharedCtx.mcpClients.values()) client.close();
  server.close();
  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${"─".repeat(40)}\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
