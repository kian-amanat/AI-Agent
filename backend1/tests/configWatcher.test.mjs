/**
 * tests/configWatcher.test.mjs
 * Run with: node tests/configWatcher.test.mjs
 *
 * Live config reload against a REAL filesystem watcher — no mocked fs, no
 * simulated events.
 *
 * The properties that matter: a bad edit must never take a workspace's hooks
 * away (rollback), a no-op save must not fire anything, an editor's burst of
 * events must collapse to one reload, and ConfigChange must fire only AFTER a
 * new config is accepted.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";

import {
  ConfigWatcher, loadAndValidate,
  acquireConfigWatcher, releaseConfigWatcher, activeWatcherCount,
  getWatchedConfig, disposeAllConfigWatchers,
} from "../services/configWatcher.mjs";

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

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// Fixed sleeps are flaky under load: poll for the expected condition instead,
// then allow a short quiet period so "exactly one event" stays meaningful.
async function waitUntil(fn, { timeoutMs = 8000, quietMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) { await settle(quietMs); return true; }
    await settle(25);
  }
  await settle(quietMs);
  return false;
}

async function makeWorkspace(settings) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-cfg-"));
  await fs.mkdir(path.join(ws, ".kodo"), { recursive: true });
  if (settings !== undefined) await writeConfig(ws, settings);
  return ws;
}
const configPath = (ws) => path.join(ws, ".kodo", "settings.json");
const writeConfig = (ws, obj) => fs.writeFile(configPath(ws), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));

const hookFor = (event, command = "echo hi") => ({ [event]: [{ hooks: [{ type: "command", command }] }] });

// Start a watcher with a short debounce and collect its events.
async function startWatcher(ws, debounceMs = 60) {
  const w = new ConfigWatcher({ workspacePath: ws, debounceMs });
  const changes = [];
  const invalid = [];
  w.on("change", (e) => changes.push(e));
  w.on("invalid", (e) => invalid.push(e));
  await w.start();
  return { w, changes, invalid };
}

console.log("\n📦 validation");

await test("a valid config loads and normalises its hooks", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const r = await loadAndValidate(ws);
  assert.strictEqual(r.ok, true);
  assert.ok(r.hooks.PreToolUse);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a MISSING file is a valid empty config, not a failure", async () => {
  const ws = await makeWorkspace(undefined);
  const r = await loadAndValidate(ws);
  assert.strictEqual(r.ok, true, "deleting config must not be treated as an error");
  assert.strictEqual(r.missing, true);
  assert.deepStrictEqual(r.hooks, {});
  await fs.rm(ws, { recursive: true, force: true });
});

await test("invalid JSON is rejected", async () => {
  const ws = await makeWorkspace("{ not json");
  const r = await loadAndValidate(ws);
  assert.strictEqual(r.ok, false);
  assert.ok(/invalid JSON/.test(r.error));
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a non-object top level is rejected", async () => {
  const ws = await makeWorkspace("[1,2,3]");
  const r = await loadAndValidate(ws);
  assert.strictEqual(r.ok, false);
  assert.ok(/must contain a JSON object/.test(r.error));
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 live reload (real fs watcher)");

await test("a valid edit swaps the config and fires exactly one change", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w, changes } = await startWatcher(ws);
  try {
    assert.ok(w.current.hooks.PreToolUse, "initial config should be loaded");
    await writeConfig(ws, { hooks: hookFor("PostToolUse") });
    await waitUntil(() => changes.length >= 1);
    assert.strictEqual(changes.length, 1, `expected 1 change, got ${changes.length}`);
    assert.ok(w.current.hooks.PostToolUse, "new config must be active");
    assert.ok(!w.current.hooks.PreToolUse, "old config must be gone");
    assert.deepStrictEqual(changes[0].currentEvents, ["PostToolUse"]);
    assert.deepStrictEqual(changes[0].previousEvents, ["PreToolUse"]);
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("INVALID JSON rolls back — previous config survives, no change fires", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse", "guard.sh") });
  const { w, changes, invalid } = await startWatcher(ws);
  try {
    await writeConfig(ws, "{ broken json ###");
    await waitUntil(() => invalid.length >= 1);
    assert.strictEqual(changes.length, 0, "an invalid config must NOT announce a change");
    assert.strictEqual(invalid.length, 1, "but it must be reported");
    assert.ok(w.current.hooks.PreToolUse, "the previous hooks must still be active");
    assert.strictEqual(w.current.hooks.PreToolUse[0].handlers[0].command, "guard.sh");
    assert.strictEqual(w.rejected, 1);
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("recovery: a valid write AFTER an invalid one is accepted", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w, changes } = await startWatcher(ws);
  try {
    await writeConfig(ws, "{{{");
    await settle();
    assert.strictEqual(changes.length, 0);
    await writeConfig(ws, { hooks: hookFor("Stop") });
    await waitUntil(() => changes.length >= 1);
    assert.strictEqual(changes.length, 1, "the watcher must recover after a bad edit");
    assert.ok(w.current.hooks.Stop);
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("an UNCHANGED file (touch / identical rewrite) fires nothing", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w, changes } = await startWatcher(ws);
  try {
    const same = await fs.readFile(configPath(ws), "utf-8");
    await fs.writeFile(configPath(ws), same);
    await settle();
    await fs.writeFile(configPath(ws), same);
    await settle();
    assert.strictEqual(changes.length, 0, "byte-identical writes must not be a change");
    assert.strictEqual(w.reloads, 0);
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("RAPID successive writes debounce into a single change", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w, changes } = await startWatcher(ws, 120);
  try {
    for (let i = 0; i < 8; i++) {
      await writeConfig(ws, { hooks: hookFor("PostToolUse", `cmd-${i}`) });
    }
    await waitUntil(() => changes.length >= 1, { quietMs: 350 });
    assert.strictEqual(changes.length, 1, `burst should collapse to 1, got ${changes.length}`);
    assert.strictEqual(w.current.hooks.PostToolUse[0].handlers[0].command, "cmd-7", "the LAST write must win");
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("a PARTIAL write (truncated mid-save) rolls back, then settles on the full write", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse", "original.sh") });
  const { w, changes, invalid } = await startWatcher(ws);
  try {
    // Simulate a non-atomic writer: truncated JSON hits disk first.
    await fs.writeFile(configPath(ws), '{ "hooks": { "PostToolUse": [ { "hooks": [ { "type": "comm');
    await waitUntil(() => invalid.length >= 1);
    assert.strictEqual(w.current.hooks.PreToolUse[0].handlers[0].command, "original.sh", "must not adopt a half-written file");
    assert.ok(invalid.length >= 1);
    assert.strictEqual(changes.length, 0);

    await writeConfig(ws, { hooks: hookFor("PostToolUse", "final.sh") });
    await waitUntil(() => changes.length >= 1);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(w.current.hooks.PostToolUse[0].handlers[0].command, "final.sh");
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("DELETE then RECREATE is tracked (watch survives file replacement)", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w, changes } = await startWatcher(ws);
  try {
    await fs.rm(configPath(ws));
    await waitUntil(() => changes.length >= 1);
    assert.deepStrictEqual(w.current.hooks, {}, "deleting config must clear hooks, not freeze them");
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].missing, true);

    await writeConfig(ws, { hooks: hookFor("Stop") });
    await waitUntil(() => changes.length >= 2);
    assert.strictEqual(changes.length, 2, "recreation must be detected — a file watch would have died here");
    assert.ok(w.current.hooks.Stop);
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("an atomic rename-replace is detected (the common editor save)", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w, changes } = await startWatcher(ws);
  try {
    const tmpFile = path.join(ws, ".kodo", "settings.json.tmp");
    await fs.writeFile(tmpFile, JSON.stringify({ hooks: hookFor("PostToolUse") }));
    await fs.rename(tmpFile, configPath(ws));
    await waitUntil(() => changes.length >= 1);
    assert.strictEqual(changes.length, 1, "rename-based saves must be seen");
    assert.ok(w.current.hooks.PostToolUse);
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("unknown hook events surface as warnings without rejecting the config", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w, changes } = await startWatcher(ws);
  try {
    await writeConfig(ws, { hooks: { NotARealEvent: [{ hooks: [{ type: "command", command: "x" }] }] } });
    await waitUntil(() => changes.length >= 1);
    assert.strictEqual(changes.length, 1, "a typo is not a parse failure — the config is still valid");
    assert.ok(changes[0].warnings.some((x) => /Unknown hook event/.test(x)));
    assert.deepStrictEqual(w.current.hooks, {});
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

console.log("\n📦 in-flight isolation");

await test("a reload does NOT mutate a config snapshot an active run already took", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse", "during-run.sh") });
  const { w } = await startWatcher(ws);
  try {
    // What agent_loop does at run start: snapshot once.
    const snapshot = w.current.hooks;
    await writeConfig(ws, { hooks: hookFor("PostToolUse", "after-run.sh") });
    await waitUntil(() => !!w.current.hooks.PostToolUse);
    assert.ok(snapshot.PreToolUse, "the in-flight run's snapshot must be untouched");
    assert.strictEqual(snapshot.PreToolUse[0].handlers[0].command, "during-run.sh");
    assert.ok(w.current.hooks.PostToolUse, "while future runs see the new config");
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("the swap is atomic — a reader never sees a partial config", async () => {
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const { w } = await startWatcher(ws);
  try {
    let sawPartial = false;
    const reader = setInterval(() => {
      const c = w.current;
      // Every observation must be a complete object with exactly one shape.
      if (!c || typeof c.hooks !== "object") sawPartial = true;
    }, 2);
    for (let i = 0; i < 10; i++) {
      await writeConfig(ws, { hooks: hookFor(i % 2 ? "PreToolUse" : "PostToolUse", `c${i}`) });
      await settle(80);
    }
    clearInterval(reader);
    assert.strictEqual(sawPartial, false, "config must never be observed half-applied");
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

console.log("\n📦 registry + resource cleanup");

await test("watchers are refcounted per workspace across sessions", async () => {
  disposeAllConfigWatchers();
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  try {
    await acquireConfigWatcher(ws, "sess-a");
    await acquireConfigWatcher(ws, "sess-b");
    assert.strictEqual(activeWatcherCount(), 1, "one fs watch shared by both sessions");

    assert.strictEqual(releaseConfigWatcher(ws, "sess-a"), false, "still in use by sess-b");
    assert.strictEqual(activeWatcherCount(), 1, "a concurrent session must not be blinded");

    assert.strictEqual(releaseConfigWatcher(ws, "sess-b"), true, "last one out closes it");
    assert.strictEqual(activeWatcherCount(), 0, "no watcher may leak");
  } finally { disposeAllConfigWatchers(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("each session's listener receives the change, and is detached on release", async () => {
  disposeAllConfigWatchers();
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  const a = [];
  const b = [];
  try {
    await acquireConfigWatcher(ws, "sess-a", async (p) => { a.push(p); });
    await acquireConfigWatcher(ws, "sess-b", async (p) => { b.push(p); });

    await writeConfig(ws, { hooks: hookFor("Stop") });
    await waitUntil(() => a.length >= 1 && b.length >= 1);
    assert.strictEqual(a.length, 1, "sess-a should be notified");
    assert.strictEqual(b.length, 1, "sess-b should be notified");
    assert.strictEqual(a[0].session_id, "sess-a", "payload must identify the session");

    releaseConfigWatcher(ws, "sess-a");
    await writeConfig(ws, { hooks: hookFor("PostToolUse") });
    await waitUntil(() => b.length >= 2);
    assert.strictEqual(a.length, 1, "a released session must stop receiving events");
    assert.strictEqual(b.length, 2, "the remaining session keeps receiving them");
  } finally { disposeAllConfigWatchers(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("releasing an unknown workspace/session is a safe no-op", () => {
  assert.strictEqual(releaseConfigWatcher("/nope", "sess-x"), false);
});

await test("getWatchedConfig exposes the live snapshot", async () => {
  disposeAllConfigWatchers();
  const ws = await makeWorkspace({ hooks: hookFor("PreToolUse") });
  try {
    await acquireConfigWatcher(ws, "s");
    assert.ok(getWatchedConfig(ws).hooks.PreToolUse);
    assert.strictEqual(getWatchedConfig("/not-watched"), null);
  } finally { disposeAllConfigWatchers(); await fs.rm(ws, { recursive: true, force: true }); }
});

await test("a workspace with no .kodo dir still starts cleanly", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-cfg-bare-"));
  const w = new ConfigWatcher({ workspacePath: ws, debounceMs: 60 });
  try {
    const current = await w.start();
    assert.deepStrictEqual(current.hooks, {});
    // And it picks up a config created later.
    const changes = [];
    w.on("change", (e) => changes.push(e));
    await fs.writeFile(path.join(ws, ".kodo", "settings.json"), JSON.stringify({ hooks: hookFor("Stop") }));
    await waitUntil(() => changes.length >= 1);
    assert.strictEqual(changes.length, 1);
  } finally { w.stop(); await fs.rm(ws, { recursive: true, force: true }); }
});

disposeAllConfigWatchers();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
