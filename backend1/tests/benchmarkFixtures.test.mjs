/**
 * tests/benchmarkFixtures.test.mjs
 * Run with: node tests/benchmarkFixtures.test.mjs
 *
 * The invariant a benchmark fixture must satisfy:
 *
 *   fresh workspace → agent edits files → verification runs immediately
 *                   → with NO network dependency installation
 *
 * Violating it is expensive in a way that does not look like a bug. The
 * command-palette fixture shipped React/TS source with no scripts and no
 * node_modules, so Kodo — which cannot finish without verifying — concluded it
 * had to build a toolchain, and spent three `npm install` invocations and most
 * of a 148s run on it before a dropped connection ended the attempt. The
 * benchmark was measuring dependency bootstrapping, not the task.
 */

import assert from "assert";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

import { loadCorpus } from "../bench/corpus.mjs";
import { createWorkspace, destroyWorkspace } from "../bench/workspace.mjs";

const execFileAsync = promisify(execFile);
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.error(`  ❌ ${name}\n     ${err.message}`); failed++; }
}

const corpus = await loadCorpus();
const PALETTE = corpus.find((b) => b.id === "react/command-palette-resume");

/** Run a command in a fresh copy of the fixture, with the network unavailable. */
async function inFreshWorkspace(benchmark, fn) {
  const ws = await createWorkspace(benchmark, { parentDir: os.tmpdir() });
  try { return await fn(ws); } finally { await destroyWorkspace(ws); }
}

console.log("\n══ react/command-palette-resume: verification without install ══");

await test("the fixture declares a runnable verification script", () => {
  assert.ok(PALETTE, "benchmark missing from the corpus");
  assert.ok(PALETTE.metadata.verifyCommand, "no verifyCommand — the framework cannot verify this independently");
});

await test("a fresh workspace ships no node_modules and needs none", async () => {
  await inFreshWorkspace(PALETTE, async (ws) => {
    const hasModules = await fs.stat(path.join(ws, "node_modules")).then(() => true, () => false);
    assert.strictEqual(hasModules, false, "fixtures must not vendor dependencies");
    const pkg = JSON.parse(await fs.readFile(path.join(ws, "package.json"), "utf-8"));
    assert.deepStrictEqual(pkg.dependencies, undefined, "a fixture requiring installs breaks the invariant");
    assert.deepStrictEqual(pkg.devDependencies, undefined, "a fixture requiring installs breaks the invariant");
    assert.ok(pkg.scripts?.test, "no test script for the agent to discover");
  });
});

await test("verification RUNS immediately in a fresh workspace, offline", async () => {
  await inFreshWorkspace(PALETTE, async (ws) => {
    const started = Date.now();
    const res = await execFileAsync("node", ["--test"], { cwd: ws, timeout: 30_000 })
      .then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const elapsed = Date.now() - started;

    // It must EXECUTE — the point is that there is a verification path at all.
    const output = `${res.stdout}${res.stderr}`;
    assert.match(output, /# tests \d+/, `node --test did not run a suite:\n${output.slice(0, 500)}`);
    assert.ok(elapsed < 20_000, `verification took ${elapsed}ms — far too slow to be dependency-free`);
    assert.ok(!/Cannot find (module|package)/.test(output), `verification needs an uninstalled dependency:\n${output.slice(0, 400)}`);
  });
});

await test("verification is RED on the fresh fixture — the work is genuinely unfinished", async () => {
  // A verification path that passes before the agent does anything is worse
  // than none: it would let a do-nothing run claim it verified its work.
  await inFreshWorkspace(PALETTE, async (ws) => {
    const res = await execFileAsync("node", ["--test"], { cwd: ws, timeout: 30_000 })
      .then(() => ({ code: 0 }), (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    assert.notStrictEqual(res.code, 0, "the fixture's own suite passes before the task is done");
    assert.match(`${res.stdout}${res.stderr}`, /no commands are registered/i,
      "the failure should say what is missing, so the agent knows what to do");
  });
});

await test("verification goes GREEN once the registry is filled in", async () => {
  await inFreshWorkspace(PALETTE, async (ws) => {
    const file = path.join(ws, "src/commands.mjs");
    const src = await fs.readFile(file, "utf-8");
    await fs.writeFile(file, `${src.replace(/\/\/ TODO.*\n?/, "")}
registerCommand({ id: "reload", title: "Reload window", run: () => {} });
`, "utf-8");
    const res = await execFileAsync("node", ["--test"], { cwd: ws, timeout: 30_000 })
      .then(() => ({ code: 0, out: "" }), (e) => ({ code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }));
    assert.strictEqual(res.code, 0, `suite still failing after the work was done:\n${res.out.slice(0, 500)}`);
  });
});

await test("the registry is importable by Node alone — no build step", async () => {
  await inFreshWorkspace(PALETTE, async (ws) => {
    const { registerCommand, listCommands } = await import(`${path.join(ws, "src/commands.mjs")}`);
    assert.strictEqual(typeof registerCommand, "function");
    assert.strictEqual(typeof listCommands, "function");
  });
});

await test("the component still imports the registry it was built around", async () => {
  await inFreshWorkspace(PALETTE, async (ws) => {
    const palette = await fs.readFile(path.join(ws, "src/components/CommandPalette.tsx"), "utf-8");
    assert.match(palette, /from "\.\.\/commands\.mjs"/, "the palette's import was not updated with the rename");
    assert.match(palette, /TODO/, "the half-built markers are the task — they must still be there");
  });
});

console.log(`\n${"═".repeat(62)}`);
console.log(`  benchmark fixtures: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
