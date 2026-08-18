/**
 * tests/editSafety.test.mjs
 *
 * Regression coverage for the corruption found by the
 * `fullstack/api-and-client-wiring` five-run reproduction: an edit_file whose
 * old_string anchored a construct's OPENING line while its new_string re-closed
 * the construct, orphaning the original body and leaving the file unparseable —
 * reported to the agent as success.
 *
 * The read-before-edit guard (agent_loop.mjs) already existed and was not the
 * cause; it is covered here anyway so a future change cannot remove it silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { validateSyntax } from "../utils/syntax.util.mjs";
import { executeTool } from "../agents/nodes/agent_loop.mjs";
import { masksFailure, verificationOutcome, isTestInfraPath } from "../services/taskController.mjs";

async function workspace(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-editsafety-"));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }
  return root;
}

/** Minimal tool ctx mirroring the loop's own shape. */
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

const ROUTES = `export const routes = [
  {
    method: "GET",
    pattern: /^\\/api\\/users$/,
    handler: () => ({ status: 200 }),
  },
];
`;

// ── Test A — edit an unread file ────────────────────────────────────────────
test("A: edit_file rejects a file that was never read, and leaves it untouched", async () => {
  const root = await workspace({ "api.mjs": ROUTES });
  const ctx = ctxFor(root); // nothing read

  const res = await executeTool("edit_file", {
    path: "api.mjs",
    old_string: "export const routes = [",
    new_string: "export const routes = [ /* x */",
  }, ctx);

  assert.equal(res.success, false, "must reject an edit to an unread file");
  assert.match(res.error, /read .*first/i, "error must tell the agent to read it first");
  assert.equal(await fs.readFile(path.join(root, "api.mjs"), "utf-8"), ROUTES, "file must be unchanged");
});

// ── Test B — read, then edit ────────────────────────────────────────────────
test("B: edit_file succeeds after the file has been read", async () => {
  const root = await workspace({ "api.mjs": ROUTES });
  const ctx = ctxFor(root);

  const read = await executeTool("read_file", { path: "api.mjs" }, ctx);
  assert.equal(read.success, true);

  const res = await executeTool("edit_file", {
    path: "api.mjs",
    old_string: `    pattern: /^\\/api\\/users$/,`,
    new_string: `    pattern: /^\\/api\\/users$/, // listed`,
  }, ctx);

  assert.equal(res.success, true, res.error);
  const after = await fs.readFile(path.join(root, "api.mjs"), "utf-8");
  assert.match(after, /\/\/ listed/);
  assert.equal(validateSyntax(after, path.join(root, "api.mjs")), null, "result must still parse");
});

// ── Test C — stale / incorrect old_string ───────────────────────────────────
test("C: edit_file rejects an old_string that is not in the file, unchanged", async () => {
  const root = await workspace({ "api.mjs": ROUTES });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  const res = await executeTool("edit_file", {
    path: "api.mjs",
    old_string: "export const ROUTES = [",   // wrong case — not present
    new_string: "export const ROUTES = [1",
  }, ctx);

  assert.equal(res.success, false);
  assert.match(res.error, /old_string not found/i);
  assert.equal(await fs.readFile(path.join(root, "api.mjs"), "utf-8"), ROUTES, "file must be unchanged");
});

// ── Test D — the actual reproduction: syntax-breaking edit ──────────────────
test("D: an edit that orphans the original body is rejected, not written (.mjs)", async () => {
  const root = await workspace({ "api.mjs": ROUTES });
  const ctx = ctxFor(root, { readFiles: ["api.mjs"] });

  // Verbatim shape of the observed corruption: anchor the opening line, and
  // supply a replacement that closes the array itself.
  const res = await executeTool("edit_file", {
    path: "api.mjs",
    old_string: "export const routes = [",
    new_string: `export const routes = [
  {
    method: "GET",
    pattern: /^\\/api\\/users\\/([^/]+)$/,
    handler: (m) => ({ status: 200, body: m[0] }),
  },
];`,
  }, ctx);

  assert.equal(res.success, false, "the corrupting edit must be rejected");
  assert.match(res.error, /break the file|unchanged/i);
  assert.equal(await fs.readFile(path.join(root, "api.mjs"), "utf-8"), ROUTES, "file must be unchanged on disk");
});

test("D2: validateSyntax covers ESM/CJS extensions, not just .js", () => {
  const broken = ROUTES + "  {\n    method: \"GET\",\n  },\n];\n";
  for (const ext of [".js", ".mjs", ".cjs", ".mts", ".cts"]) {
    assert.notEqual(validateSyntax(broken, `/tmp/a${ext}`), null, `${ext} must be syntax-checked`);
    assert.equal(validateSyntax(ROUTES, `/tmp/a${ext}`), null, `${ext} must accept valid source`);
  }
  // Unknown extensions stay unchecked — this is a syntax gate, not a linter.
  assert.equal(validateSyntax(broken, "/tmp/a.txt"), null);
});

// ── Fix #3 — a masked exit code is not evidence ─────────────────────────────
test("E: `npm test || echo ...` cannot certify the workspace", () => {
  assert.equal(masksFailure("npm test || echo 'no test script'"), true);
  assert.equal(masksFailure("npm run build || npm test"), true);
  assert.equal(masksFailure("npm test ; true"), true);
  // Legitimate shell usage is untouched.
  assert.equal(masksFailure("npm test"), false);
  assert.equal(masksFailure("npm run lint && npm test"), false);
  assert.equal(masksFailure("npm test || exit 1"), false, "re-raising the failure is not a mask");

  const green = JSON.stringify({ exit_code: 0, stdout: "# pass 3\n# fail 0" });
  assert.equal(verificationOutcome(true, green, "npm test").passed, true, "a clean run still passes");
  const masked = verificationOutcome(true, green, "npm test || echo 'no test script'");
  assert.equal(masked.passed, false, "a masked exit code must not certify");
  assert.match(masked.why, /masked/i);
});

test("F: a missing test script is missing verification, not passing verification", () => {
  const out = JSON.stringify({ exit_code: 0, stdout: "npm ERR! Missing script: \"test\"" });
  const r = verificationOutcome(true, out, "npm test");
  assert.equal(r.passed, false);
  assert.match(r.why, /no such script/i);
});

// ── Fix #4 — editing the harness is not proof about the implementation ──────
test("G: test-infrastructure paths are classified apart from implementation", () => {
  for (const p of ["package.json", "server/package.json", "vitest.config.ts",
                   "tsconfig.json", "src/foo.test.mjs", "tests/x.mjs"]) {
    assert.equal(isTestInfraPath(p), true, `${p} should be test infra`);
  }
  for (const p of ["server/api.mjs", "client/App.mjs", "src/lib/pricing.mjs"]) {
    assert.equal(isTestInfraPath(p), false, `${p} should be implementation`);
  }
});
