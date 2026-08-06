/**
 * tests/resumeCompletion.test.mjs
 * Run with: node tests/resumeCompletion.test.mjs
 *
 * Covers the completion rules specific to RESUME tasks — picking up work that
 * already half exists in the tree.
 *
 * The failure these exist to stop is narrow and was observed live: given
 * "resume the palette work in CommandPalette.tsx and wire it up", the agent
 * edited App.tsx to import and render the palette, and finished. Every gate
 * was satisfied — a pre-existing file changed (integration), one file changed
 * (resume's minimum) — while the component named in the request still carried
 * both of its TODOs and neither keyboard behaviour existed.
 *
 * Two rules close it, and both are bounded: they challenge once and then let
 * the run proceed, so an agent that genuinely finished in an unusual shape is
 * never trapped.
 */

import assert from "assert";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  createTaskController, classifyTask, namedFiles,
  verificationOutcome, isVacuousTestRun,
} from "../services/taskController.mjs";
import { findUnresolvedMarkers } from "../agents/nodes/agent_loop.mjs";

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

const PALETTE_TASK =
  "Resume the command palette work — finish what's already started in src/components/CommandPalette.tsx and wire it up so it actually works.";

const edits = (c, ...paths) => {
  for (const p of paths) c.recordToolCall({ tool: "edit_file", args: { path: p }, ok: true });
};

// ── naming ──────────────────────────────────────────────────────────────────
console.log("\n══ files named in the request ════════════════════════════════");

await test("a path in the request is extracted as a basename", () => {
  assert.deepStrictEqual(namedFiles(PALETTE_TASK), ["commandpalette.tsx"]);
});

await test("several named files are all extracted, de-duplicated", () => {
  assert.deepStrictEqual(
    namedFiles("finish src/a.ts and lib/b.tsx, then update src/a.ts again").sort(),
    ["a.ts", "b.tsx"]
  );
});

await test("a request naming no files yields none", () => {
  assert.deepStrictEqual(namedFiles("resume the half-built settings page"), []);
});

await test("the palette task is still classified as a resume", () => {
  const intent = classifyTask(PALETTE_TASK);
  assert.strictEqual(intent.shape, "resume");
  assert.strictEqual(intent.mentionsIntegration, true);
  assert.deepStrictEqual(intent.named, ["commandpalette.tsx"]);
});

// ── the observed failure ────────────────────────────────────────────────────
console.log("\n══ wiring a file up is not finishing it ══════════════════════");

await test("editing only the integration point does not satisfy a resume", () => {
  // Exactly the observed run: App.tsx imports and renders the palette; the
  // palette itself is untouched.
  const c = createTaskController({ task: PALETTE_TASK });
  c.recordToolCall({ tool: "read_file", args: { path: "src/components/CommandPalette.tsx" }, ok: true });
  edits(c, "src/App.tsx");

  const gate = c.canFinish({ editedPaths: ["src/App.tsx"], responseText: "Wired the palette into the app." });
  assert.strictEqual(gate.allowed, false, "this must not be allowed to finish");
  assert.strictEqual(gate.kind, "incomplete_shape");
  assert.match(gate.directive, /commandpalette\.tsx/i);
  assert.match(gate.directive, /wiring it up is not finishing it/i);
});

await test("editing the named file as well clears the shape gate", () => {
  const c = createTaskController({ task: PALETTE_TASK });
  edits(c, "src/components/CommandPalette.tsx", "src/App.tsx");
  const gate = c.canFinish({
    editedPaths: ["src/components/CommandPalette.tsx", "src/App.tsx"],
    responseText: "Finished the palette and wired it up.",
  });
  // It moves on to the verification gate — which is the correct next demand.
  assert.notStrictEqual(gate.kind, "incomplete_shape");
});

await test("a path prefix mismatch is not mistaken for unfinished work", () => {
  // The request says src/components/CommandPalette.tsx; the edit is recorded
  // relative to a different root. Same file, and it must not be challenged.
  const c = createTaskController({ task: PALETTE_TASK });
  edits(c, "components/CommandPalette.tsx");
  const gate = c.canFinish({ editedPaths: ["components/CommandPalette.tsx"], responseText: "Done." });
  assert.notStrictEqual(gate.kind, "incomplete_shape");
});

await test("the shape challenge is issued once and cannot trap a run", () => {
  const c = createTaskController({ task: PALETTE_TASK });
  edits(c, "src/App.tsx");
  const first = c.canFinish({ editedPaths: ["src/App.tsx"], responseText: "Done." });
  assert.strictEqual(first.allowed, false);
  // An agent that insists it is finished must be able to.
  for (let i = 0; i < 6; i++) {
    const again = c.canFinish({ editedPaths: ["src/App.tsx"], responseText: "That really was all of it." });
    assert.notStrictEqual(again.kind, "incomplete_shape", "the resume demand must not repeat");
  }
});

await test("a NON-resume task naming a file it did not edit is never challenged for it", () => {
  // "add a helper to utils.ts and use it in App.tsx" is not a resume; demanding
  // that every named file change would be a false accusation.
  const c = createTaskController({ task: "Add a formatCurrency helper to utils.ts and use it in App.tsx" });
  edits(c, "App.tsx");
  const gate = c.canFinish({ editedPaths: ["App.tsx"], responseText: "Done." });
  const unmet = c.snapshot().unmet.join(" ");
  assert.ok(!/wiring it up is not finishing it/.test(unmet), `resume rule leaked into another shape: ${unmet}`);
});

// ── leftover markers ────────────────────────────────────────────────────────
console.log("\n══ leftover TODO markers on a resume ═════════════════════════");

async function withFiles(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-markers-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content, "utf-8");
    }
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

await test("markers are found from disk, with file and line", async () => {
  await withFiles(
    { "src/P.tsx": `export function P() {\n  // TODO: close on Escape\n  return <div/>;\n}\n` },
    async (dir) => {
      const markers = await findUnresolvedMarkers(dir, ["src/P.tsx"]);
      assert.strictEqual(markers.length, 1);
      assert.strictEqual(markers[0].file, "src/P.tsx");
      assert.strictEqual(markers[0].line, 2);
      assert.match(markers[0].text, /TODO: close on Escape/);
    }
  );
});

await test("FIXME, XXX and HACK all count; block comments too", async () => {
  await withFiles(
    { "a.ts": `/* FIXME: broken */\n// XXX: revisit\n# HACK: temporary\n/** TODO: finish */\n` },
    async (dir) => {
      const markers = await findUnresolvedMarkers(dir, ["a.ts"]);
      assert.strictEqual(markers.length, 4, JSON.stringify(markers));
    }
  );
});

await test("durable pragmas are NOT unfinished work", async () => {
  await withFiles(
    {
      "a.ts": `// eslint-disable-next-line no-console\n// @ts-expect-error legacy shim\n// prettier-ignore\nexport const x = 1;\n`,
    },
    async (dir) => {
      assert.deepStrictEqual(await findUnresolvedMarkers(dir, ["a.ts"]), [],
        "config directives are permanent, not a record of unfinished work");
    }
  );
});

await test("a word merely containing 'todo' is not a marker", async () => {
  await withFiles(
    { "a.ts": `const todoList = [];\nexport function addTodo() { return todoList; }\n` },
    async (dir) => {
      assert.deepStrictEqual(await findUnresolvedMarkers(dir, ["a.ts"]), []);
    }
  );
});

await test("a deleted or unreadable file is skipped, not thrown on", async () => {
  await withFiles({ "a.ts": "// TODO: x\n" }, async (dir) => {
    const markers = await findUnresolvedMarkers(dir, ["a.ts", "gone.ts"]);
    assert.strictEqual(markers.length, 1);
  });
});

await test("a resume that leaves its markers behind is pushed back", async () => {
  await withFiles(
    {
      "src/P.tsx": `export function P() {\n  // TODO: close on Escape\n  // TODO: run the selected command on Enter\n  return <div/>;\n}\n`,
    },
    async (dir) => {
      const markers = await findUnresolvedMarkers(dir, ["src/P.tsx"]);
      const c = createTaskController({ task: "Resume the palette work in src/P.tsx and wire it up so it actually works." });
      edits(c, "src/P.tsx", "src/App.tsx");
      const gate = c.canFinish({
        editedPaths: ["src/P.tsx", "src/App.tsx"],
        responseText: "The palette is complete.",
        unresolvedMarkers: markers,
      });
      assert.strictEqual(gate.allowed, false, "editing the file but leaving its TODOs is not finishing it");
      assert.strictEqual(gate.kind, "unresolved_markers");
      assert.match(gate.directive, /close on Escape/);
      assert.match(gate.directive, /run the selected command on Enter/);
    }
  );
});

await test("the marker challenge is issued once and cannot trap a run", () => {
  const markers = [{ file: "src/P.tsx", line: 2, text: "TODO: something" }];
  const c = createTaskController({ task: "Resume the work in src/P.tsx and wire it up so it works." });
  edits(c, "src/P.tsx");
  const first = c.canFinish({ editedPaths: ["src/P.tsx"], responseText: "Done.", unresolvedMarkers: markers });
  assert.strictEqual(first.kind, "unresolved_markers");
  for (let i = 0; i < 6; i++) {
    const again = c.canFinish({ editedPaths: ["src/P.tsx"], responseText: "That TODO is out of scope.", unresolvedMarkers: markers });
    assert.notStrictEqual(again.kind, "unresolved_markers", "the marker demand must not repeat");
  }
});

await test("a resume with no markers left is not challenged", () => {
  const c = createTaskController({ task: "Resume the work in src/P.tsx and wire it up so it works." });
  edits(c, "src/P.tsx");
  const gate = c.canFinish({ editedPaths: ["src/P.tsx"], responseText: "Done.", unresolvedMarkers: [] });
  assert.notStrictEqual(gate.kind, "unresolved_markers");
});

await test("a NON-resume task may leave TODOs alone", () => {
  // Ordinary work should never be nagged about pre-existing TODOs.
  const markers = [{ file: "src/P.tsx", line: 2, text: "TODO: unrelated" }];
  const c = createTaskController({ task: "Add a health endpoint to server.mjs" });
  edits(c, "server.mjs");
  const gate = c.canFinish({ editedPaths: ["server.mjs"], responseText: "Done.", unresolvedMarkers: markers });
  assert.notStrictEqual(gate.kind, "unresolved_markers", "TODOs are ordinary outside a resume task");
});

await test("leftover markers are recorded in the snapshot for the report", () => {
  const markers = [{ file: "src/P.tsx", line: 2, text: "TODO: something" }];
  const c = createTaskController({ task: "Resume the work in src/P.tsx and wire it up so it works." });
  edits(c, "src/P.tsx");
  c.canFinish({ editedPaths: ["src/P.tsx"], responseText: "Done.", unresolvedMarkers: markers });
  c.canFinish({ editedPaths: ["src/P.tsx"], responseText: "Done.", unresolvedMarkers: markers });
  assert.deepStrictEqual(c.snapshot().markersOnFinish, ["src/P.tsx:2"]);
});

// ── vacuous verification ────────────────────────────────────────────────────
console.log("\n══ a check that ran nothing is not verification ══════════════");

await test("a test command that ran zero tests does not count as passing", () => {
  // `node --test` in a project with no test files exits 0. Observed live: an
  // agent that could not run the project's real (missing) runner reached for
  // `node --test`, got a clean exit, and finished believing the suite was green.
  const out = JSON.stringify({ exit_code: 0, stdout: "# tests 0\n# pass 0\n# fail 0\n# duration_ms 2.6\n" });
  const r = verificationOutcome(true, out);
  assert.strictEqual(r.passed, false);
  assert.match(r.why, /zero tests/);
});

await test("a test command that actually ran tests still passes", () => {
  assert.strictEqual(
    verificationOutcome(true, JSON.stringify({ exit_code: 0, stdout: "# tests 3\n# pass 3\n# fail 0\n" })).passed,
    true
  );
});

await test("`# tests 10` is not mistaken for `# tests 0`", () => {
  assert.strictEqual(isVacuousTestRun("# tests 10\n# pass 10\n"), false);
});

await test("the other runners' empty-run phrasings are recognised", () => {
  for (const phrase of [
    "No tests found, exiting with code 0",
    "No test files found",
    "no tests ran in 0.01s",
    "found no tests",
  ]) {
    assert.strictEqual(isVacuousTestRun(phrase), true, `not recognised: ${phrase}`);
  }
});

await test("a non-test check with no output is unaffected", () => {
  // tsc prints nothing when it is happy; that is a real pass.
  assert.strictEqual(verificationOutcome(true, JSON.stringify({ exit_code: 0, stdout: "" })).passed, true);
});

await test("a vacuous run leaves the controller unverified", () => {
  const c = createTaskController({ task: "Run the project's test suite and tell me the result." });
  c.recordVerification({
    command: "node --test",
    passed: true,
    output: JSON.stringify({ exit_code: 0, stdout: "# tests 0\n# pass 0\n" }),
  });
  const snap = c.snapshot();
  assert.strictEqual(snap.verificationCurrent, false,
    "a command that ran zero tests must not certify the workspace");
});

// ── the protections that must survive ───────────────────────────────────────
console.log("\n══ nothing else was weakened ═════════════════════════════════");

await test("a question is still never forced to mutate", () => {
  const c = createTaskController({ task: "What does rateLimiter.mjs do when a client exceeds the limit?" });
  const gate = c.canFinish({ editedPaths: [], responseText: "It returns { allowed: false, retryAfterMs }." });
  assert.strictEqual(gate.allowed, true, "a question naming a file must not be pushed to edit it");
});

await test("describing a change instead of applying it is still refused", () => {
  const c = createTaskController({ task: "Resume the palette work in src/P.tsx and wire it up so it works." });
  const gate = c.canFinish({ editedPaths: [], responseText: "```tsx\nconst x = 1;\n```" });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.kind, "no_mutation");
});

await test("an honest blocker still ends the run without a success verdict", () => {
  const c = createTaskController({ task: "Resume the palette work in src/P.tsx and wire it up so it works." });
  for (let i = 0; i < 12; i++) {
    c.recordToolCall({ tool: "edit_file", args: { path: "src/P.tsx" }, ok: false, output: "EACCES: permission denied" });
    if (c.endIteration().stop) break;
  }
  const snap = c.snapshot();
  assert.ok(snap.stopReason, "a wall must still stop the run");
  assert.notStrictEqual(snap.stopReason, "verified", "a blocked run must never read as verified");
  assert.ok(c.blockerReport().length > 0, "the blocker must still be reported");
});

console.log(`\n${"═".repeat(62)}`);
console.log(`  resume completion: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
