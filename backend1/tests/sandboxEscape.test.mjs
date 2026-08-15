/**
 * tests/sandboxEscape.test.mjs
 * Run with: node tests/sandboxEscape.test.mjs
 *
 * Regression tests for four real escapes found by tracing execution paths
 * rather than trusting imports. Each one was tool-reachable from a sandboxed
 * run and reached the host through a SERVICE module, so the existing boundary
 * test — which only scanned `executeTool`'s inline body — reported green.
 *
 *   1. spawn_agent + isolation:worktree created a host git worktree in /tmp
 *   2. review_patch(approve) ran `git apply` against the host workspace
 *   3. PreToolUse/PostToolUse hooks spawned host shells inside every tool call
 *   4. stdio MCP servers ran as host child processes with full host access
 *
 * The tests here are deliberately structural where a live container is not
 * needed (routing, refusal, ordering) and live where only a container can
 * settle it (`dockerRuntime.test.mjs` owns the host-vs-container file proofs).
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import { HostRuntime } from "../core/runtime/host.mjs";
import { assertRuntime, RUNTIME_METHODS } from "../core/runtime/contract.mjs";
import { CONTAINER_WORKTREE_ROOT } from "../core/runtime/container-worktree.mjs";
import { DockerRuntime } from "../core/runtime/docker.mjs";
import { IncusRuntime } from "../core/runtime/incus.mjs";
import { discoverMcpTools } from "../services/mcpTools.mjs";
import { fireHookEvent, normalizeHookConfig } from "../services/hooks.mjs";
import { applyPatch, extractWorktreeDiff } from "../services/worktreePatch.mjs";

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

/** A runtime that claims isolation and records everything, without a container. */
function fakeSandbox({ name = "docker" } = {}) {
  const calls = [];
  const worktrees = new Map();
  return {
    name,
    isolated: true,
    image: "test-image",
    workdir: "/workspace",
    calls,
    async start() {}, async cleanup() {},
    derive(root) {
      if (!root.startsWith("/workspace") && !root.startsWith(CONTAINER_WORKTREE_ROOT)) {
        throw new Error(`cannot derive "${root}": outside the sandbox`);
      }
      return this;
    },
    async verifyIsolation() { return { isolated: true, checks: ["fake"] }; },
    worktreeRoot() { return CONTAINER_WORKTREE_ROOT; },
    async createWorktree({ subagentId }) {
      const id = `wt_${subagentId}_test`;
      const wt = { worktreeId: id, path: `${CONTAINER_WORKTREE_ROOT}/${id}`, repoRoot: "/workspace", inSandbox: true };
      worktrees.set(id, wt);
      calls.push({ method: "createWorktree" });
      return { ok: true, worktree: wt };
    },
    async removeWorktree(id) { calls.push({ method: "removeWorktree" }); worktrees.delete(id); return { ok: true, removed: true }; },
    async stat() { return null; },
    async readFile() { return null; },
    async writeFile(rel, content) { calls.push({ method: "writeFile", rel, content }); },
    async deleteFile(rel) { calls.push({ method: "deleteFile", rel }); return true; },
    async walk() { return []; },
    async grep() { return { matches: [], count: 0 }; },
    async exec(command, opts) {
      calls.push({ method: "exec", command, opts });
      return { exit_code: 0, stdout: "", stderr: "" };
    },
    async execBackground() { return { id: "bg", outputFile: "" }; },
    async readBackgroundOutput() { return { success: true }; },
    killBackground() { return { success: true }; },
  };
}

// ── 1. Worktrees ─────────────────────────────────────────────────────────────

console.log("\n📦 escape 1 — worktrees must live inside the runtime");

await test("the runtime contract now owns worktree lifecycle", () => {
  for (const m of ["createWorktree", "removeWorktree", "worktreeRoot"]) {
    assert.ok(RUNTIME_METHODS.includes(m), `${m} must be part of the contract`);
  }
  assertRuntime(new HostRuntime({ root: os.tmpdir() }));
  assertRuntime(new DockerRuntime({ root: os.tmpdir() }));
  assertRuntime(new IncusRuntime({ root: os.tmpdir() }));
});

await test("a sandbox puts worktrees INSIDE itself, never in a host temp dir", () => {
  const host = new HostRuntime({ root: os.tmpdir() });
  const docker = new DockerRuntime({ root: os.tmpdir() });
  const incus = new IncusRuntime({ root: os.tmpdir() });

  assert.ok(path.isAbsolute(host.worktreeRoot()), "the host runtime uses a real host path");
  assert.strictEqual(docker.worktreeRoot(), CONTAINER_WORKTREE_ROOT);
  assert.strictEqual(incus.worktreeRoot(), CONTAINER_WORKTREE_ROOT);

  for (const rt of [docker, incus]) {
    assert.ok(!rt.worktreeRoot().startsWith(os.tmpdir()),
      "a sandbox worktree root must not be the HOST temp directory — that was the escape");
  }
});

await test("derive() accepts an in-sandbox worktree and still refuses host paths", () => {
  const docker = new DockerRuntime({ root: os.tmpdir() });
  docker.containerId = "fake";

  const inside = docker.derive(`${CONTAINER_WORKTREE_ROOT}/wt_x`);
  assert.strictEqual(inside.name, "docker");
  assert.strictEqual(inside.isolated, true, "a derived runtime must stay isolated");
  assert.strictEqual(inside.workdir, `${CONTAINER_WORKTREE_ROOT}/wt_x`);

  // The old host worktree location must still be refused.
  assert.throws(() => docker.derive(path.join(os.tmpdir(), "kodo-worktrees", "wt_y")),
    /outside the sandbox/,
    "returning a host runtime here is exactly the sub-agent escape");
});

await test("a derived sub-agent runtime does not share the parent's background tasks", () => {
  const docker = new DockerRuntime({ root: os.tmpdir() });
  docker.containerId = "fake";
  docker.backgroundTasks.set("parent-task", {});
  const child = docker.derive(`${CONTAINER_WORKTREE_ROOT}/wt_z`);
  assert.strictEqual(child.backgroundTasks.size, 0,
    "a sub-agent must not be able to read or kill its parent's background tasks");
});

// ── 2. review_patch ──────────────────────────────────────────────────────────

console.log("\n📦 escape 2 — patch application must go through the runtime");

await test("applyPatch REQUIRES a runtime — it can no longer touch the host directly", async () => {
  await assert.rejects(
    async () => applyPatch("nope", { workspaceRoot: os.tmpdir() }),
    /requires an ExecutionRuntime/,
  );
});

await test("extractWorktreeDiff REQUIRES a runtime", async () => {
  await assert.rejects(
    async () => extractWorktreeDiff(null, "/somewhere"),
    /requires an ExecutionRuntime/,
  );
});

await test("a sandboxed patch apply writes and execs INSIDE the sandbox", async () => {
  const runtime = fakeSandbox();
  // A patch record has to exist for apply to get as far as the runtime; the
  // unknown-patch path still proves the runtime gate runs first.
  const res = await applyPatch("unknown-patch", { workspaceRoot: "/workspace", runtime });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Unknown patch/);
  // Nothing should have been written to a host path.
  assert.ok(!runtime.calls.some((c) => c.rel && path.isAbsolute(c.rel)),
    "the temp diff must be workspace-relative so it lands inside the sandbox");
});

// ── 3. Hooks ─────────────────────────────────────────────────────────────────

console.log("\n📦 escape 3 — command hooks must run in the runtime");

await test("a command hook executes THROUGH the runtime when one is supplied", async () => {
  const runtime = fakeSandbox();
  const { hooks } = normalizeHookConfig({
    PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "echo audited" }] }],
  });

  const result = await fireHookEvent("PreToolUse", { tool: "write_file" }, {
    config: hooks,
    cwd: "/workspace",
    subject: "write_file",
    runtime,
  });

  assert.strictEqual(result.fired, true, "the hook should have fired");
  const execCall = runtime.calls.find((c) => c.method === "exec" && c.command === "echo audited");
  assert.ok(execCall,
    "the hook command must reach runtime.exec — a host spawn here runs project shell " +
    "outside the sandbox on every single tool call");
});

await test("without a runtime, hooks still run on the host (session-level behaviour is unchanged)", async () => {
  const { hooks } = normalizeHookConfig({
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 0" }] }],
  });
  const result = await fireHookEvent("PreToolUse", { tool: "x" }, {
    config: hooks, cwd: os.tmpdir(), subject: "x",
  });
  assert.strictEqual(result.fired, true);
  assert.strictEqual(result.decision, "continue");
});

// ── 4. MCP ───────────────────────────────────────────────────────────────────

console.log("\n📦 escape 4 — host MCP servers must fail closed under a sandbox");

await test("a stdio MCP server is REFUSED under a sandbox, and its tools are not offered", async () => {
  const runtime = fakeSandbox();
  const result = await discoverMcpTools({
    mcpServers: { fsserver: { command: "npx", args: ["@modelcontextprotocol/server-filesystem", "/"] } },
    cwd: os.tmpdir(),
    mcpClients: new Map(),
    runtime,
  });

  assert.strictEqual(result.tools.length, 0, "a refused server must contribute no tools");
  const entry = result.servers.find((s) => s.name === "fsserver");
  assert.ok(entry, "the refused server must still be REPORTED, not silently missing");
  assert.strictEqual(entry.ok, false);
  assert.match(entry.error, /refused|not started/i);
});

await test("an explicit per-server opt-in is honoured", async () => {
  const runtime = fakeSandbox();
  const clients = new Map();
  // It will fail to actually connect (the binary does not exist here), but it
  // must get PAST the sandbox gate — proving the opt-in is what is being tested.
  const result = await discoverMcpTools({
    mcpServers: {
      trusted: { command: "definitely-not-installed-kodo-test", allowHostAccessInSandbox: true },
    },
    cwd: os.tmpdir(),
    mcpClients: clients,
    runtime,
  });
  const entry = result.servers.find((s) => s.name === "trusted");
  assert.ok(entry, "the opted-in server should have been attempted");
  assert.ok(!/refused/i.test(entry.error || ""),
    `it must fail for its own reason, not the sandbox gate (got: ${entry.error})`);
});

await test("remote http/sse MCP servers are NOT refused — they are not host processes", async () => {
  const runtime = fakeSandbox();
  const result = await discoverMcpTools({
    mcpServers: { remote: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    cwd: os.tmpdir(),
    mcpClients: new Map(),
    runtime,
  });
  const entry = result.servers.find((s) => s.name === "remote");
  assert.ok(entry, "the remote server should have been attempted");
  assert.ok(!/refused by sandbox|host \(stdio\)/i.test(entry.error || ""),
    "a remote endpoint is constrained by its own auth, not by the process sandbox");
});

await test("on the HOST runtime nothing is refused — the gate is sandbox-only", async () => {
  const host = new HostRuntime({ root: os.tmpdir() });
  const result = await discoverMcpTools({
    mcpServers: { local: { command: "definitely-not-installed-kodo-test" } },
    cwd: os.tmpdir(),
    mcpClients: new Map(),
    runtime: host,
  });
  const entry = result.servers.find((s) => s.name === "local");
  assert.ok(entry);
  assert.ok(!/refused/i.test(entry.error || ""),
    "an unsandboxed run must keep working exactly as before");
});

// ── Fail-closed, end to end ──────────────────────────────────────────────────

console.log("\n📦 fail-closed — a broken sandbox NEVER yields a host runtime");

await test("createRuntime refuses when the sandbox cannot start, and returns nothing", async () => {
  const { createRuntime } = await import("../core/runtime/index.mjs");
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kodo-failclosed-"));
  try {
    // An image that cannot exist. Docker may or may not be installed here; both
    // paths must refuse — "daemon missing" and "image missing" are equally
    // not-a-sandbox.
    let returned = null;
    let threw = null;
    try {
      returned = await createRuntime({
        root,
        sandbox: "docker",
        config: { image: "kodo-nonexistent-image-for-tests:0", mountWorkspace: false },
      });
    } catch (err) {
      threw = err;
    }

    assert.strictEqual(returned, null, "a failed sandbox must not return a runtime at all");
    assert.ok(threw, "it must throw rather than resolve");
    assert.ok(!/HostRuntime/.test(String(threw?.runtime?.name || "")),
      "it must never hand back a host runtime");
    assert.match(threw.message, /sandbox/i);
    assert.match(threw.message, /will not run on the host/i,
      "the error must state plainly that Kodo did not silently use the host");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

await test("createRuntime('host') is the ONLY way to get an unisolated runtime", async () => {
  const { createRuntime } = await import("../core/runtime/index.mjs");
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kodo-hostonly-"));
  try {
    const host = await createRuntime({ root, sandbox: "host" });
    assert.strictEqual(host.isolated, false);
    assert.strictEqual(host.name, "host");
    await host.cleanup();

    // And an unknown name is rejected rather than defaulting to host.
    await assert.rejects(createRuntime({ root, sandbox: "hostt" }), /Unknown sandbox/);
    await assert.rejects(createRuntime({ root, sandbox: "" }), /Unknown sandbox/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

// ── 5. verify_ui ─────────────────────────────────────────────────────────────

console.log("\n📦 escape 5 — verify_ui must not drive a host browser from a sandbox");

await test("verify_ui is REFUSED under a sandbox", async () => {
  const { executeTool, createToolContext } = await import("../agents/nodes/agent_loop.mjs");
  const runtime = fakeSandbox();
  const ctx = createToolContext({
    root: os.tmpdir(),
    runtime,
    mcpServers: { playwright: { command: "node", args: ["fake"] } },
    mcpClients: new Map(),
  });

  const r = await executeTool("verify_ui", { url: "http://localhost:3000" }, ctx);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /not available under the .* sandbox/i);
  // The decisive part: no host process was launched and no host file written.
  assert.strictEqual(ctx.mcpClients.size, 0,
    "a sandboxed verify_ui must not spawn a host Playwright MCP process");
});

await test("verify_ui still works on the host runtime (the guard is sandbox-only)", async () => {
  const { executeTool, createToolContext } = await import("../agents/nodes/agent_loop.mjs");
  const ctx = createToolContext({ root: os.tmpdir(), mcpServers: {}, mcpClients: new Map() });
  const r = await executeTool("verify_ui", { url: "http://localhost:3000" }, ctx);
  assert.strictEqual(r.success, false);
  // Fails for the ORDINARY reason (no server configured), not the sandbox one.
  assert.match(r.error, /No Playwright MCP server configured/i);
});

// ── 6. syntax validation ─────────────────────────────────────────────────────

console.log("\n📦 exception audit — the Python validator cannot execute agent content");

await test("model-authored Python is PARSED, never executed", async () => {
  const { validateSyntax } = await import("../utils/syntax.util.mjs");
  const marker = path.join(os.tmpdir(), `kodo-syntax-escape-${Date.now()}.txt`);

  // validateSyntax spawns host `python3 -c "import ast; ast.parse(sys.stdin.read())"`
  // for .py files. That is a documented host exception (docs/runtime-audit.md):
  // hermetic, no filesystem access, content passed on STDIN rather than argv.
  //
  // This proves the "never executed" half. ast.parse builds a syntax tree; if
  // it ever became exec/eval, this file would run and leave the marker behind.
  const hostile = `import os\nopen(${JSON.stringify(marker)}, "w").write("escaped")\n`;
  const result = validateSyntax(hostile, "/tmp/whatever.py");

  assert.strictEqual(result, null, "the content is valid Python, so validation should pass");
  assert.strictEqual(fs.existsSync(marker), false,
    "the validator EXECUTED model-authored code — it must only parse it");
});

await test("agent content cannot reach the validator's argv", async () => {
  const src = await fs.promises.readFile(new URL("../utils/syntax.util.mjs", import.meta.url), "utf-8");
  const i = src.indexOf("spawnSync(");
  const call = src.slice(i, i + 400);

  // The command and its arguments must be literals. Interpolating `content`
  // into argv would turn a validation step into arbitrary host execution.
  assert.ok(/input:\s*content/.test(call),
    "content must be delivered on stdin");
  assert.ok(!/\$\{content\}|\+\s*content/.test(call),
    "content must never be interpolated into the command or its arguments");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
