/**
 * tests/rewriteSafety.test.mjs
 *
 * Regression coverage for the failure that became dominant once the .mjs
 * syntax gate started rejecting corrupting edits: a rejected edit_file is
 * followed by a full-file write_file, and the reconstructed file silently
 * omits exports the task never asked to touch.
 *
 * Observed in the fullstack reproduction: client/apiClient.mjs lost
 * setTransport + request (run 4); server/api.mjs lost handle() (run 5).
 * Dropping an export leaves the file perfectly parseable, so validateSyntax
 * cannot see it — this is a separate invariant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { executeTool } from "../agents/nodes/agent_loop.mjs";
import { removedExports, exportedNames, validateSyntax } from "../utils/syntax.util.mjs";

const MULTI = `export function handle() { return 1; }
export function setTransport(fn) { return fn; }
export const routes = [];
`;

async function workspace(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-rewrite-"));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }
  return root;
}

function ctxFor(root, { readFiles = [] } = {}) {
  return {
    root,
    readFiles: new Set(readFiles),
    editedFiles: new Map(),
    todosRef: { current: [] },
    runtime: {
      readFile: async (rel) => {
        try { return await fs.readFile(path.join(root, rel), "utf-8"); } catch { return null; }
      },
      writeFile: async (rel, content) => fs.writeFile(path.join(root, rel), content),
    },
  };
}

// ── Test 1 — a failed targeted edit loses nothing ───────────────────────────
test("1: a rejected edit_file leaves every existing export intact", async () => {
  const root = await workspace({ "api.mjs": MULTI });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  const res = await executeTool("edit_file", {
    path: "api.mjs",
    old_string: "export const routes = [];",
    new_string: "export const routes = [ {",   // unbalanced — must be rejected
  }, ctx);

  assert.equal(res.success, false);
  const after = await fs.readFile(path.join(root, "api.mjs"), "utf-8");
  assert.equal(after, MULTI, "file must be byte-identical");
  assert.deepEqual(exportedNames(after, "/x/api.mjs").sort(), ["handle", "routes", "setTransport"]);
});

// ── Test 2 — no blind full-file overwrite after a stale edit ────────────────
test("2: a rewrite that drops exports is rejected, file unchanged", async () => {
  const root = await workspace({ "api.mjs": MULTI });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  // Exactly the observed shape: valid syntax, but only the targeted export survives.
  const res = await executeTool("write_file", {
    path: "api.mjs",
    content: `export const routes = [{ method: "GET" }];\n`,
  }, ctx);

  assert.equal(res.success, false, "must not silently drop exports");
  assert.match(res.error, /would delete .*export/i);
  assert.match(res.error, /handle/);
  assert.match(res.error, /setTransport/);
  assert.equal(await fs.readFile(path.join(root, "api.mjs"), "utf-8"), MULTI, "file must be unchanged");
});

// ── Test 3 — a correct recovery still works ─────────────────────────────────
test("3: a complete rewrite applies the change and preserves the rest", async () => {
  const root = await workspace({ "api.mjs": MULTI });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  const complete = `export function handle() { return 1; }
export function setTransport(fn) { return fn; }
export const routes = [{ method: "GET" }];
`;
  const res = await executeTool("write_file", { path: "api.mjs", content: complete }, ctx);

  assert.equal(res.success, true, res.error);
  const after = await fs.readFile(path.join(root, "api.mjs"), "utf-8");
  assert.match(after, /method: "GET"/, "intended change applied");
  assert.deepEqual(exportedNames(after, "/x/api.mjs").sort(), ["handle", "routes", "setTransport"]);
  assert.equal(validateSyntax(after, "/x/api.mjs"), null, "syntax still valid");
});

// ── Test 4 — repeated failure fails honestly, file survives ─────────────────
test("4: repeated bad rewrites never destroy the file", async () => {
  const root = await workspace({ "api.mjs": MULTI });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  for (let i = 0; i < 3; i++) {
    const res = await executeTool("write_file", {
      path: "api.mjs",
      content: `export const routes = [${i}];\n`,
    }, ctx);
    assert.equal(res.success, false, "each attempt must be rejected");
  }
  assert.equal(await fs.readFile(path.join(root, "api.mjs"), "utf-8"), MULTI, "file survives intact");
});

// ── The bypass must not exist ───────────────────────────────────────────────
test("5: allow_removals does NOT bypass the guard (the flag is gone)", async () => {
  const root = await workspace({ "api.mjs": MULTI });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  const res = await executeTool("write_file", {
    path: "api.mjs",
    content: `export const routes = [];\n`,
    allow_removals: true,
  }, ctx);

  assert.equal(res.success, false, "a model-set flag must not re-enable a destructive rewrite");
  assert.match(res.error, /would delete .*export/i);
  assert.equal(await fs.readFile(path.join(root, "api.mjs"), "utf-8"), MULTI, "file must be unchanged");
});

test("5b: no equivalent override argument works either", async () => {
  const root = await workspace({ "api.mjs": MULTI });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  for (const flag of ["allow_removals", "force", "override", "unsafe", "confirm", "yes"]) {
    const res = await executeTool("write_file", {
      path: "api.mjs",
      content: `export const routes = [];\n`,
      [flag]: true,
    }, ctx);
    assert.equal(res.success, false, `"${flag}: true" must not bypass the guard`);
    assert.equal(await fs.readFile(path.join(root, "api.mjs"), "utf-8"), MULTI, `file changed via "${flag}"`);
  }
});

test("5c: the tool schema exposes no removal-override argument to the model", async () => {
  const { AGENT_TOOLS } = await import("../agents/nodes/agent_loop.mjs");
  const wf = AGENT_TOOLS.find((t) => t.function?.name === "write_file");
  assert.ok(wf, "write_file must be in the exposed tool list");
  const props = Object.keys(wf.function.parameters.properties);
  assert.deepEqual(props.sort(), ["content", "path"],
    `write_file must expose only path+content, got: ${props.join(", ")}`);
});

// ── §9 mandatory negative test: the exact observed failure ──────────────────
test("NEGATIVE: the exact v-fs-7/v-fs-8 failure cannot happen", async () => {
  // Byte-for-byte the shape from the benchmark: handle() + routes, rewritten
  // down to routes alone, first plainly and then with the flag the model used.
  const before = `export function handle() {}\nexport const routes = [];\n`;
  const root = await workspace({ "server/api.mjs": before });
  const ctx = ctxFor(root, { readFiles: ["server/api.mjs"] });
  const destructive = `export const routes = [];\n`;

  const first = await executeTool("write_file", { path: "server/api.mjs", content: destructive }, ctx);
  assert.equal(first.success, false, "attempt 1 must be rejected");
  assert.match(first.error, /handle/);

  const second = await executeTool("write_file", {
    path: "server/api.mjs", content: destructive, allow_removals: true,
  }, ctx);
  assert.equal(second.success, false, "attempt 2 (the observed bypass) must ALSO be rejected");
  assert.match(second.error, /handle/);

  assert.equal(await fs.readFile(path.join(root, "server/api.mjs"), "utf-8"), before,
    "the original file must remain byte-for-byte unchanged");
});

// ── Deliberate deletion still has a path: edit_file ─────────────────────────
test("5d: edit_file remains the way to remove an export on purpose", async () => {
  const root = await workspace({ "api.mjs": MULTI });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  const res = await executeTool("edit_file", {
    path: "api.mjs",
    old_string: "export function setTransport(fn) { return fn; }\n",
    new_string: "",
  }, ctx);

  assert.equal(res.success, true, res.error);
  const after = await fs.readFile(path.join(root, "api.mjs"), "utf-8");
  assert.deepEqual(exportedNames(after, "/x/api.mjs").sort(), ["handle", "routes"]);
  assert.equal(validateSyntax(after, "/x/api.mjs"), null, "still parses");
});

// ── Creating a new file is unaffected ───────────────────────────────────────
test("6: creating a brand-new file is not gated", async () => {
  const root = await workspace({});
  const ctx = ctxFor(root);
  const res = await executeTool("write_file", { path: "fresh.mjs", content: "export const a = 1;\n" }, ctx);
  assert.equal(res.success, true, res.error);
});

// ── The analysis primitives ─────────────────────────────────────────────────
test("7: removedExports understands the real export forms and fails safe", () => {
  assert.deepEqual(removedExports(MULTI, `export const routes = [];\n`, "/x/a.mjs").sort(),
    ["handle", "setTransport"]);
  assert.deepEqual(removedExports(MULTI, MULTI, "/x/a.mjs"), []);

  // export { a as b } and default
  const named = `const a = 1;\nexport { a as alpha };\nexport default function d() {}\n`;
  assert.deepEqual(exportedNames(named, "/x/a.mjs").sort(), ["alpha", "default"]);
  assert.deepEqual(removedExports(named, `const a = 1;\nexport { a as alpha };\n`, "/x/a.mjs"), ["default"]);

  // Unparseable or unknown types → "cannot tell", never a false accusation.
  assert.deepEqual(removedExports(MULTI, "export const routes = [ {", "/x/a.mjs"), []);
  assert.deepEqual(removedExports(MULTI, "anything", "/x/a.txt"), []);
});
