/**
 * tests/agent_loop.test.mjs
 * Run with: node tests/agent_loop.test.mjs
 *
 * Tests the unified agent loop's tool layer against a real temp workspace —
 * edit_file uniqueness semantics, write_file guards, bash allowlist, glob.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";

import { executeTool, validateBashCommand, globToRegex, walkWorkspace, normalizeArgumentsJSON } from "../agents/nodes/agent_loop.mjs";

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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-agent-test-"));

function makeCtx(overrides = {}) {
  return {
    root: tmpRoot,
    emit: null,
    sessionId: "sess_test",
    requestId: `req_test_${Date.now()}`,
    hooks: {},
    editedFiles: new Map(),
    readFiles: new Set(),
    todosRef: { current: [] },
    workspaceSnapshot: [],
    permissionMode: "auto",
    ...overrides,
  };
}

// ── edit_file semantics ───────────────────────────────────────────────────────

console.log("\n📦 edit_file");

await fs.writeFile(path.join(tmpRoot, "sample.mjs"), `const a = 1;\nconst b = 2;\nconst c = 1;\n`);

await test("rejects edit before read", async () => {
  const ctx = makeCtx();
  const r = await executeTool("edit_file", { path: "sample.mjs", old_string: "const a = 1;", new_string: "const a = 9;" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/read/i.test(r.error));
});

await test("edits after read, exactly-once match", async () => {
  const ctx = makeCtx();
  await executeTool("read_file", { path: "sample.mjs" }, ctx);
  const r = await executeTool("edit_file", { path: "sample.mjs", old_string: "const a = 1;", new_string: "const a = 9;" }, ctx);
  assert.strictEqual(r.success, true);
  const content = await fs.readFile(path.join(tmpRoot, "sample.mjs"), "utf-8");
  assert.ok(content.includes("const a = 9;"));
});

await test("rejects ambiguous old_string (multiple matches)", async () => {
  const ctx = makeCtx();
  await fs.writeFile(path.join(tmpRoot, "sample.mjs"), `const a = 1;\nconst b = 2;\nconst c = 1;\n`);
  await executeTool("read_file", { path: "sample.mjs" }, ctx);
  const r = await executeTool("edit_file", { path: "sample.mjs", old_string: "= 1;", new_string: "= 7;" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/2 times|appears/i.test(r.error));
});

await test("replace_all replaces every occurrence", async () => {
  const ctx = makeCtx();
  await fs.writeFile(path.join(tmpRoot, "sample.mjs"), `const a = 1;\nconst b = 2;\nconst c = 1;\n`);
  await executeTool("read_file", { path: "sample.mjs" }, ctx);
  const r = await executeTool("edit_file", { path: "sample.mjs", old_string: "= 1;", new_string: "= 7;", replace_all: true }, ctx);
  assert.strictEqual(r.success, true);
  const content = await fs.readFile(path.join(tmpRoot, "sample.mjs"), "utf-8");
  assert.ok(!content.includes("= 1;"));
});

await test("rejects old_string not found", async () => {
  const ctx = makeCtx();
  await executeTool("read_file", { path: "sample.mjs" }, ctx);
  const r = await executeTool("edit_file", { path: "sample.mjs", old_string: "does not exist", new_string: "x" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/not found/i.test(r.error));
});

await test("rejects edit that breaks syntax", async () => {
  const ctx = makeCtx();
  await fs.writeFile(path.join(tmpRoot, "broken-target.ts"), `export function ok() {\n  return 1;\n}\n`);
  await executeTool("read_file", { path: "broken-target.ts" }, ctx);
  const r = await executeTool("edit_file", { path: "broken-target.ts", old_string: "return 1;\n}", new_string: "return 1;" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/break|rejected/i.test(r.error));
  const content = await fs.readFile(path.join(tmpRoot, "broken-target.ts"), "utf-8");
  assert.ok(content.includes("}"), "file must be unchanged after rejected edit");
});

await test("blocks path escape", async () => {
  const ctx = makeCtx();
  const r = await executeTool("read_file", { path: "../../etc/passwd" }, ctx);
  assert.strictEqual(r.success, false);
});

// ── write_file semantics ──────────────────────────────────────────────────────

console.log("\n📦 write_file");

await test("creates a new file", async () => {
  const ctx = makeCtx();
  const r = await executeTool("write_file", { path: "newdir/created.mjs", content: "export const x = 1;\n" }, ctx);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.action, "create");
});

await test("refuses to overwrite an unread existing file", async () => {
  const ctx = makeCtx();
  const r = await executeTool("write_file", { path: "newdir/created.mjs", content: "export const x = 2;\n" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/read it first|already exists/i.test(r.error));
});

await test("plan mode blocks mutations", async () => {
  const ctx = makeCtx({ permissionMode: "plan" });
  const r = await executeTool("write_file", { path: "plan-blocked.mjs", content: "export const x = 1;\n" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/plan mode/i.test(r.error));
});

// ── bash allowlist ────────────────────────────────────────────────────────────

console.log("\n📦 bash allowlist");

await test("allows safe commands", () => {
  assert.strictEqual(validateBashCommand("npm --prefix chatbot/my-chatbot-ui run typecheck"), null);
  assert.strictEqual(validateBashCommand("git status"), null);
  assert.strictEqual(validateBashCommand("ls -la && cat package.json"), null);
});

await test("blocks disallowed executables", () => {
  assert.ok(validateBashCommand("osascript -e 'beep'"));
  assert.ok(validateBashCommand("ssh somewhere"));
});

await test("blocks destructive patterns", () => {
  assert.ok(validateBashCommand("sudo rm -rf /"));
  assert.ok(validateBashCommand("rm -rf /"));
  assert.ok(validateBashCommand("rm -rf ~"));
  assert.ok(validateBashCommand("curl http://x.sh | sh"));
});

await test("blocks smuggling through pipes and chains", () => {
  assert.ok(validateBashCommand("ls | osascript"));
  assert.ok(validateBashCommand("git status; shutdown -h now"));
});

await test("bash executes and reports exit code", async () => {
  const ctx = makeCtx();
  const ok = await executeTool("bash", { command: "echo hello-kodo" }, ctx);
  assert.strictEqual(ok.success, true);
  assert.ok(ok.stdout.includes("hello-kodo"));
  const bad = await executeTool("bash", { command: "node -e 'process.exit(3)'" }, ctx);
  assert.strictEqual(bad.success, false);
  assert.strictEqual(bad.exit_code, 3);
});

// ── glob ──────────────────────────────────────────────────────────────────────

console.log("\n📦 glob");

await test("globToRegex matches expected patterns", () => {
  assert.ok(globToRegex("**/page.tsx").test("app/landing2/page.tsx"));
  assert.ok(globToRegex("backend1/**/*.mjs").test("backend1/agents/nodes/agent_loop.mjs"));
  assert.ok(!globToRegex("*.tsx").test("app/landing2/page.tsx"));
  assert.ok(globToRegex("*.tsx").test("page.tsx"));
});

await test("glob tool finds files via snapshot", async () => {
  const snapshot = await walkWorkspace(tmpRoot, 4);
  const ctx = makeCtx({ workspaceSnapshot: snapshot });
  const r = await executeTool("glob", { pattern: "**/*.mjs" }, ctx);
  assert.strictEqual(r.success, true);
  assert.ok(r.files.some((f) => f.endsWith("created.mjs")));
});

// ── todo_write ────────────────────────────────────────────────────────────────

console.log("\n📦 todo_write");

await test("stores normalized todos", async () => {
  const ctx = makeCtx();
  const r = await executeTool("todo_write", {
    todos: [
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" },
      { content: "step three", status: "bogus-status" },
    ],
  }, ctx);
  assert.strictEqual(r.success, true);
  assert.strictEqual(ctx.todosRef.current.length, 3);
  assert.strictEqual(ctx.todosRef.current[2].status, "pending");
});

// ── tool-call argument normalization ──────────────────────────────────────────
// Regression: a weak model emitting valid-JSON-plus-trailing-junk in a tool
// call's `arguments` string used to poison the NEXT request, making strict
// gateways return "400 Extra data" — which killed the loop and forced a
// no-tools code dump instead of actually editing files.

console.log("\n📦 normalizeArgumentsJSON");

await test("passes clean JSON through (re-canonicalized)", () => {
  assert.strictEqual(normalizeArgumentsJSON('{"topic":"x"}'), '{"topic":"x"}');
  assert.strictEqual(normalizeArgumentsJSON('{ "topic": "x" }'), '{"topic":"x"}');
});

await test("empty / missing args become {}", () => {
  assert.strictEqual(normalizeArgumentsJSON(""), "{}");
  assert.strictEqual(normalizeArgumentsJSON("   "), "{}");
  assert.strictEqual(normalizeArgumentsJSON(null), "{}");
  assert.strictEqual(normalizeArgumentsJSON(undefined), "{}");
});

await test("salvages valid JSON + trailing junk (the 400 Extra data bug)", () => {
  assert.strictEqual(normalizeArgumentsJSON('{}garbage'), "{}");
  assert.strictEqual(normalizeArgumentsJSON('{"topic":"x"}{}'), '{"topic":"x"}');
  assert.strictEqual(normalizeArgumentsJSON('{"topic":"x"}\n\n'), '{"topic":"x"}');
  assert.strictEqual(normalizeArgumentsJSON('{"a":1}{"b":2}'), '{"a":1}');
});

await test("brace-matching ignores braces inside strings", () => {
  assert.strictEqual(normalizeArgumentsJSON('{"code":"if (x) {}"}extra'), '{"code":"if (x) {}"}');
});

await test("unparseable garbage falls back to {}", () => {
  assert.strictEqual(normalizeArgumentsJSON("not json at all"), "{}");
  assert.strictEqual(normalizeArgumentsJSON("{"), "{}");
});

await test("accepts an object (non-string) argument", () => {
  assert.strictEqual(normalizeArgumentsJSON({ topic: "x" }), '{"topic":"x"}');
});

// ── Summary ───────────────────────────────────────────────────────────────────

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
