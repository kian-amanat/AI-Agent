/**
 * tests/workspaceQuery.test.mjs — regression guard for the false
 * "I can't access your workspace" answer.
 *
 * The shipped bug, in one session:
 *
 *     User:  go and see your workspace to get feels like home
 *     Kodo:  [inspects the repo, lists chatbot/, backend1/, cli/, docs/]
 *     User:  where is the CLI stored?
 *     Kodo:  I don't have visibility into your actual project files
 *            ... I can only reason about the public internet, not your workspace.
 *
 * Two independent defects produced that:
 *   1. ROUTING — "where is the CLI stored?" is a question, so the router's
 *      question fast-path sent it to the answer node, which holds only
 *      web_search/fetch_url and cannot read a single file.
 *   2. FALSE FALLBACK — the answer node's own prompt told it that it had no
 *      view of the project, so instead of escalating it reported that as a
 *      property of Kodo. Kodo's agent mode has read_file/grep/glob/bash; the
 *      claim was never true.
 *
 * The workspace assertions below run the REAL tools (executeTool over a real
 * runtime, on a real temp workspace) — the answer is discovered, never
 * hardcoded, so a test can't pass while the tool path is broken.
 *
 * Run with: node tests/workspaceQuery.test.mjs
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import { classifyFastPath, isWorkspaceQuery } from "../agents/nodes/router.mjs";
import { claimsNoWorkspaceAccess } from "../agents/nodes/answer.mjs";
import { createToolContext, executeTool, agentLoopNode } from "../agents/nodes/agent_loop.mjs";
import { HostRuntime } from "../core/runtime/index.mjs";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

// ── A real temp workspace, shaped like the one from the bug report ───────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodo-wsq-"));
fs.mkdirSync(path.join(tmp, "cli", "bin"), { recursive: true });
fs.mkdirSync(path.join(tmp, "backend1"), { recursive: true });
fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
fs.writeFileSync(path.join(tmp, "cli", "bin", "kodo.mjs"), "#!/usr/bin/env node\nconsole.log('kodo');\n");
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
  name: "kodo-agent",
  bin: { kodo: "./cli/bin/kodo.mjs" },
}, null, 2));
fs.writeFileSync(path.join(tmp, "backend1", "server.mjs"), "export const port = 3000;\n");

async function buildCtx(root = tmp) {
  const runtime = new HostRuntime({ root });
  await runtime.start();
  return createToolContext({ root, runtime, workspaceSnapshot: await runtime.walk("", 8) });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n📦 Router — workspace-dependent questions reach a tool-capable path");

await test("THE regression: \"where is the CLI stored?\" is not answer-mode", () => {
  assert.strictEqual(isWorkspaceQuery("where is the CLI stored?"), true);
  assert.strictEqual(classifyFastPath("where is the CLI stored?"), "agent");
});

await test("workspace questions of every shape route to agent", () => {
  for (const msg of [
    "where is package.json?",
    "where is authentication implemented?",
    "what files are in this project?",
    "which component renders the login screen?",
    "where is the agent loop?",
    "find the API route for chat",
    "show me the project structure",
    "what does this repository contain?",
    "what frontend framework does this project use?",
    "how is the frontend structured?",
    "which file contains the router?",
    "where is this function defined?",
    "find the authentication logic",
  ]) {
    assert.strictEqual(classifyFastPath(msg), "agent", `expected agent for: "${msg}"`);
  }
});

console.log("\n📦 Router — the cheap answer path is preserved (the fix must not over-trigger)");

await test("general-knowledge questions do NOT trigger workspace exploration", () => {
  for (const msg of [
    "what is React?",
    "what does HTTP mean?",
    "explain closures in JavaScript",
    "what is a closure in JavaScript?",
    "what is a stack?",
    "how does JWT authentication work?",
    "why does React re-render on state change?",
  ]) {
    assert.strictEqual(isWorkspaceQuery(msg), false, `should not be a workspace query: "${msg}"`);
    assert.notStrictEqual(classifyFastPath(msg), "agent", `should not route to agent: "${msg}"`);
  }
});

await test("action/task requests still route to the agent (no routing regression)", () => {
  for (const msg of [
    "fix the auth bug",
    "refactor this component",
    "add a feedback form to the page",
    "go ahead and apply that",
  ]) {
    assert.strictEqual(classifyFastPath(msg), "agent", `expected agent for: "${msg}"`);
  }
  // "add dark mode" names no noun the fast path knows, so it stays ambiguous
  // (→ LLM classifier, which defaults to agent). Pre-existing behaviour; what
  // matters here is that it is never force-answered.
  assert.notStrictEqual(classifyFastPath("add dark mode"), "answer");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n📦 Workspace tools actually answer the question (real execution, real files)");

await test("the CLI location is DISCOVERED from the workspace, not assumed", async () => {
  const ctx = await buildCtx();

  // 1. top-level listing — what actually exists
  const ls = await executeTool("list_files", {}, ctx);
  assert.strictEqual(ls.success, true, "list_files failed");
  assert.ok(ls.entries.some((e) => e === "DIR  cli"), `no cli/ dir in listing: ${ls.entries.join(", ")}`);

  // 2. the package manifest answers "where is the CLI" exactly, via its bin field
  const manifest = await executeTool("read_file", { path: "package.json" }, ctx);
  assert.strictEqual(manifest.success, true, "read_file package.json failed");
  const bin = JSON.parse(manifest.content).bin;
  assert.deepStrictEqual(bin, { kodo: "./cli/bin/kodo.mjs" });

  // 3. the declared entry point is real — verified through the runtime
  const entry = await executeTool("read_file", { path: "cli/bin/kodo.mjs" }, ctx);
  assert.strictEqual(entry.success, true, "declared CLI entry point does not exist");

  // The grounded answer is assembled from those results only.
  const answer = `The CLI is in ./cli/. Its entry point is ${bin.kodo}.`;
  assert.ok(answer.includes("./cli/bin/kodo.mjs"));
  assert.strictEqual(claimsNoWorkspaceAccess(answer), false);
});

await test("glob/grep find workspace files for a location question", async () => {
  const ctx = await buildCtx();
  const g = await executeTool("glob", { pattern: "cli/**/*.mjs" }, ctx);
  assert.strictEqual(g.success, true);
  assert.ok(g.files.includes("cli/bin/kodo.mjs"), `glob missed the entry point: ${g.files.join(", ")}`);
});

await test("a path-shaped glob guessed against the wrong root still finds the file", async () => {
  const ctx = await buildCtx();
  // The model guesses "bin/kodo.mjs" — real file is cli/bin/kodo.mjs. Anchored
  // at the root this matches nothing, and the model concludes "no CLI exists".
  const res = await executeTool("glob", { pattern: "bin/kodo.mjs" }, ctx);
  assert.strictEqual(res.success, true);
  assert.ok(res.files.includes("cli/bin/kodo.mjs"), `suffix fallback failed: ${JSON.stringify(res)}`);
  assert.match(res.note || "", /subproject|instead/i, "the fallback should be reported, not silent");
});

await test("a genuinely absent file says so AND says how to widen the search", async () => {
  const ctx = await buildCtx();
  const res = await executeTool("glob", { pattern: "src/nothing-here.ts" }, ctx);
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(res.files, []);
  assert.match(res.note, /does NOT mean it doesn't exist/i);
  assert.strictEqual(claimsNoWorkspaceAccess(res.note), false);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n📦 Honest fallback — failures report their real cause");

await test("a missing file yields the real error, not an access complaint", async () => {
  const ctx = await buildCtx();
  const res = await executeTool("read_file", { path: "cli/bin/nope.mjs" }, ctx);
  assert.strictEqual(res.success, false);
  assert.match(res.error, /not found/i, `error lost its cause: ${res.error}`);
  assert.strictEqual(claimsNoWorkspaceAccess(res.error), false);
});

await test("a search with no match is a finding about the project, not a limitation", async () => {
  const ctx = await buildCtx();
  const res = await executeTool("grep", { pattern: "definitelyNotInThisRepo_zzz" }, ctx);
  assert.strictEqual(res.success, true, "grep itself should succeed");
  assert.strictEqual(res.count, 0);
  // The honest phrasing for this case must survive the false-claim detector.
  assert.strictEqual(
    claimsNoWorkspaceAccess("I searched the workspace but could not find a matching CLI entry point."),
    false,
  );
});

await test("no workspace connected → says exactly that, and names why", async () => {
  const missing = path.join(tmp, "does-not-exist");
  const out = await agentLoopNode({
    workspacePath: missing,
    userMessage: "where is the CLI stored?",
    modelRoute: {},
    runtime: new HostRuntime({ root: missing }),
  });
  assert.match(out.finalAnswer, /No workspace is currently connected/i, out.finalAnswer);
  assert.ok(out.finalAnswer.includes(missing), "the real path should be named");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n📦 The false-claim backstop in the answer node");

await test("detects the exact sentences Kodo shipped", () => {
  for (const claim of [
    "I don't have visibility into your actual project files",
    "I don't have visibility into your actual workspace files — I can only reason about the public internet, not your workspace.",
    "I cannot access your workspace.",
    "I can't see your files.",
    "I have no live view of your project files.",
    "Unfortunately I only have access to the public internet.",
  ]) {
    assert.strictEqual(claimsNoWorkspaceAccess(claim), true, `missed false claim: "${claim}"`);
  }
});

await test("does not fire on honest reports (no over-blocking)", () => {
  for (const ok of [
    "The CLI is in ./cli/. Its entry point is ./cli/bin/kodo.mjs.",
    "I searched the workspace but could not find a matching CLI entry point.",
    "Couldn't inspect the workspace — grep failed: ENOENT: no such file or directory.",
    "No workspace is currently connected.",
    "React is a UI library for building component-based interfaces.",
  ]) {
    assert.strictEqual(claimsNoWorkspaceAccess(ok), false, `false positive on: "${ok}"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n📦 The prompts no longer teach the false claim");

await test("answer node's prompt forbids, rather than asserts, the limitation", async () => {
  const src = fs.readFileSync(new URL("../agents/nodes/answer.mjs", import.meta.url), "utf8");
  const prompt = src.slice(src.indexOf("const SYSTEM_PROMPT"), src.indexOf("const ESCALATE_SENTINEL"));
  assert.ok(
    /NEVER tell the user you/.test(prompt),
    "answer prompt lost its ban on false workspace-access claims",
  );
  assert.ok(
    !/web_search\/fetch_url only reach the public internet, never the user's own workspace\./.test(prompt),
    "the sentence that taught the false claim is back in the prompt",
  );
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
