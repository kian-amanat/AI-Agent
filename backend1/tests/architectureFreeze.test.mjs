/**
 * tests/architectureFreeze.test.mjs
 * Run with: node tests/architectureFreeze.test.mjs
 *
 * The architecture is frozen. This file is what "frozen" means in practice.
 *
 *     CLI ─┐
 *     UI ──┼→ Local API → Kodo Core → Agent Graph → Tools → Runtime ─┬→ Host
 *     VSC ─┘                                                          ├→ Docker
 *                                                                     └→ Incus
 *
 * Every assertion below encodes a property that was expensive to establish and
 * cheap to lose. None of them test behaviour the other suites already cover —
 * they test SHAPE, which is exactly what erodes silently during ordinary
 * feature work and which no individual code review reliably catches.
 *
 * If one of these fails, the right response is almost never "update the test".
 * It is "the change moved a boundary — was that intended, and is it documented?"
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..");
const REPO = path.resolve(BACKEND, "..");

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

const read = (p) => fs.readFileSync(p, "utf-8");

console.log("\n📦 architecture freeze");

// ── One agent ────────────────────────────────────────────────────────────────

await test("there is exactly ONE agent entry point", () => {
  // Every surface must reach the agent through graph_runner. A second entry
  // point is how "one agent" quietly becomes two that drift apart.
  const runner = read(path.join(BACKEND, "services", "graph_runner.mjs"));
  assert.ok(runner.includes("export async function runKodoGraph"),
    "graph_runner.runKodoGraph is the single agent entry point");

  // Nothing outside the graph may invoke the loop node directly.
  const offenders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "tests", "bench", "uploads", "data", ".git"].includes(entry.name)) continue;
        scan(full);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) continue;
      const rel = path.relative(BACKEND, full);
      // kodo_graph legitimately wires the node into the graph.
      if (rel === path.join("agents", "kodo_graph.mjs")) continue;
      if (rel === path.join("agents", "nodes", "agent_loop.mjs")) continue;
      if (/\bagentLoopNode\s*\(/.test(read(full))) offenders.push(rel);
    }
  };
  scan(BACKEND);
  assert.deepStrictEqual(offenders, [],
    `agentLoopNode must only be invoked by the graph. Called directly in: ${offenders.join(", ")}`);
});

await test("the CLI does not implement its own agent loop", () => {
  const agentBridge = read(path.join(REPO, "cli", "src", "agent.mjs"));
  assert.ok(/core\.runAgent\(/.test(agentBridge),
    "the CLI must call core.runAgent, not re-implement the loop");

  const cliSrc = path.join(REPO, "cli", "src");
  const offenders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith(".mjs")) continue;
      const text = read(full);
      // A tool-dispatch switch or a provider call inside the CLI would mean a
      // second agent had started to grow here.
      if (/chat\/completions|executeTool\s*\(|buildKodoGraph/.test(text)) {
        offenders.push(path.relative(REPO, full));
      }
    }
  };
  scan(cliSrc);
  assert.deepStrictEqual(offenders, [],
    `the CLI must not contain agent internals. Found in: ${offenders.join(", ")}`);
});

// ── Core independence ────────────────────────────────────────────────────────

await test("Kodo Core has no editor dependency", () => {
  const offenders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "tests", "uploads", "data", ".git"].includes(entry.name)) continue;
        scan(full);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) continue;
      if (/require\(["']vscode["']\)|from\s+["']vscode["']/.test(read(full))) {
        offenders.push(path.relative(BACKEND, full));
      }
    }
  };
  for (const d of ["core", "agents", "services", "utils", "config"]) scan(path.join(BACKEND, d));
  assert.deepStrictEqual(offenders, [], `core must not import vscode: ${offenders.join(", ")}`);
});

await test("importing core requires no credentials, database or workspace", async () => {
  // `kodo --version` and `kodo doctor` import this on a machine with nothing
  // configured. If that ever needs a key again, those commands break exactly
  // when they are most needed.
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const core = await import("../core/index.mjs");
    assert.ok(core.VERSION, "core should expose a version without credentials");
    assert.strictEqual(typeof core.runAgent, "function");
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});

// ── The runtime boundary ─────────────────────────────────────────────────────

await test("the runtime contract is complete and all three implement it", async () => {
  const { RUNTIME_METHODS, assertRuntime } = await import("../core/runtime/contract.mjs");
  const { HostRuntime } = await import("../core/runtime/host.mjs");
  const { DockerRuntime } = await import("../core/runtime/docker.mjs");
  const { IncusRuntime } = await import("../core/runtime/incus.mjs");

  // Freeze the surface. Adding a method is fine; REMOVING one silently drops a
  // class of operation out of the sandbox.
  for (const required of [
    "start", "cleanup", "derive", "verifyIsolation",
    "stat", "readFile", "writeFile", "deleteFile", "walk", "grep",
    "exec", "execBackground", "readBackgroundOutput", "killBackground",
    "createWorktree", "removeWorktree", "worktreeRoot",
  ]) {
    assert.ok(RUNTIME_METHODS.includes(required), `the contract lost "${required}"`);
  }

  for (const R of [HostRuntime, DockerRuntime, IncusRuntime]) {
    assertRuntime(new R({ root: os.tmpdir() }));
  }
});

await test("only HostRuntime reports itself unisolated; containers report isolated", async () => {
  const { HostRuntime } = await import("../core/runtime/host.mjs");
  const { DockerRuntime } = await import("../core/runtime/docker.mjs");
  const { IncusRuntime } = await import("../core/runtime/incus.mjs");

  assert.strictEqual(new HostRuntime({ root: os.tmpdir() }).isolated, false);
  assert.strictEqual(new DockerRuntime({ root: os.tmpdir() }).isolated, true);
  assert.strictEqual(new IncusRuntime({ root: os.tmpdir() }).isolated, true);
});

await test("no source file outside core/runtime constructs a container runtime", () => {
  // Runtimes are selected through createRuntime(), which is where verification
  // and the fail-closed rule live. Constructing one directly would skip both.
  const offenders = [];
  const scan = (dir, label) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "tests", "runtime", ".git", "data", "uploads"].includes(entry.name)) continue;
        scan(full, label);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) continue;
      if (/new\s+(DockerRuntime|IncusRuntime)\s*\(/.test(read(full))) {
        offenders.push(path.relative(REPO, full));
      }
    }
  };
  scan(path.join(BACKEND, "core"), "core");
  scan(path.join(BACKEND, "services"), "services");
  scan(path.join(BACKEND, "agents"), "agents");
  scan(path.join(REPO, "cli", "src"), "cli");
  assert.deepStrictEqual(offenders, [],
    `container runtimes must be built via createRuntime(): direct construction in ${offenders.join(", ")}`);
});

await test("the sandbox selector has exactly one place that can return a runtime", () => {
  const selector = read(path.join(BACKEND, "core", "runtime", "index.mjs"));
  // Every `return runtime` must be preceded by verification. Structurally: the
  // function must contain the isolation check and must throw when it fails.
  assert.ok(/verifyIsolation\(\)/.test(selector), "createRuntime must call verifyIsolation");
  assert.ok(/if \(!report\?\.isolated\)/.test(selector), "it must branch on the result");
  assert.ok(/Refusing to run/.test(selector), "and refuse rather than continue");
  assert.ok(!/catch[\s\S]{0,200}new HostRuntime/.test(selector),
    "a catch block that falls back to HostRuntime would defeat the entire boundary");
});

// ── Clients ──────────────────────────────────────────────────────────────────

await test("the Local API is the only thing the web UI talks to", () => {
  const uiLib = read(path.join(REPO, "chatbot", "my-chatbot-ui", "app", "lib", "api.ts"));
  assert.ok(/KODO_API_ORIGIN/.test(uiLib), "the UI must route through a configurable API origin");
  // The browser must never be handed a shell.
  assert.ok(!/child_process|require\(["']fs["']\)/.test(uiLib),
    "the browser must not execute commands or touch the filesystem");
});

await test("VS Code is optional — nothing in core requires it", () => {
  // The extension lives in a separate repository and speaks to the Local API.
  // Core must not gain a hard dependency on it existing.
  const coreIndex = read(path.join(BACKEND, "core", "index.mjs"));
  assert.ok(!/vscode/i.test(coreIndex), "core/index.mjs must not reference VS Code");
});

// ── Claims discipline ────────────────────────────────────────────────────────

await test("only VERIFIED sandboxes are advertised", async () => {
  const { VERIFIED_SANDBOXES, advertisedSandboxes, INCUS_OPT_IN } = await import("../core/runtime/index.mjs");
  const previous = process.env[INCUS_OPT_IN];
  delete process.env[INCUS_OPT_IN];
  try {
    assert.deepStrictEqual([...VERIFIED_SANDBOXES], ["host", "docker"],
      "a sandbox may only join this list once its isolation is proven against live infrastructure");
    assert.ok(!advertisedSandboxes().includes("incus"));
  } finally {
    if (previous !== undefined) process.env[INCUS_OPT_IN] = previous;
  }
});

// ── Release identity ─────────────────────────────────────────────────────────

await test("every manifest reports the SAME version", () => {
  // The CLI, Core and the published package each carry a version, and a user
  // sees all three (`kodo --version`, `kodo version --json`, `npm view`). If
  // they drift, "which version am I actually running" stops having an answer —
  // and the CLI's own core-mismatch warning starts firing on a correct install.
  const read = (rel) => JSON.parse(read_(path.join(REPO, rel))).version;
  const read_ = (p) => fs.readFileSync(p, "utf-8");

  const cli = read("cli/package.json");
  const core = read("backend1/package.json");
  const root = read("package.json");

  assert.strictEqual(core, cli, `backend1 is ${core} but the CLI is ${cli}`);
  assert.strictEqual(root, cli, `the root manifest is ${root} but the CLI is ${cli}`);
  assert.match(cli, /^\d+\.\d+\.\d+(-[\w.]+)?$/, `"${cli}" is not a valid semver`);
});

await test("no manifest in the repository is a publishable 'kodo-agent'", () => {
  // This is a regression test for a shipped bug, not a style rule.
  //
  // 2.0.0-rc.1 was published by running `npm publish` in the repository root.
  // The root manifest had been renamed to "kodo-agent", given a `bin`, and had
  // its `private` flag removed — so it looked exactly like the real package and
  // npm accepted it. But it declares no `dependencies`, so users installed the
  // source with nothing to run it: "Cannot find package '@langchain/core'".
  //
  // The only publishable kodo-agent manifest is the one the build script
  // generates into dist-npm/, which is not tracked here. Every manifest that
  // lives in the repository must therefore be unpublishable.
  const manifests = ["package.json", "cli/package.json", "backend1/package.json",
    "chatbot/my-chatbot-ui/package.json"];

  for (const rel of manifests) {
    const m = JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf-8"));
    assert.strictEqual(m.private, true,
      `${rel} is not marked private — \`npm publish\` in that directory would succeed`);
    assert.notStrictEqual(m.name, "kodo-agent",
      `${rel} is named "kodo-agent"; only the generated dist-npm/ manifest may claim that name`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
