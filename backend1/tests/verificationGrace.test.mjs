/**
 * tests/verificationGrace.test.mjs
 *
 * Fix A — the verification reprieve.
 *
 * Reproduces the deadlock found in the fullstack benchmark: an agent finishes
 * a multi-file implementation, follows its own VERIFY instructions (re-read the
 * edited region and the project manifest), and is killed by the no-progress
 * rule before it reaches the bash call — a stop that bypasses canFinish() and
 * therefore never issues the mandatory verification directive.
 *
 * The reprieve spends that streak on the request instead of on the stop. It is
 * one-shot, it never supplies verification, and it leaves every existing
 * evidence-quality rule untouched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskController } from "../services/taskController.mjs";

const TASK = "Add a GET /api/users/:id endpoint, a getUser(id) client function, and wire the view to it.";

const edit = (c, p) => c.recordToolCall({ tool: "edit_file", args: { path: p }, ok: true });
const read = (c, p) => c.recordToolCall({ tool: "read_file", args: { path: p }, ok: true });
const todo = (c) => c.recordToolCall({ tool: "todo_write", args: {}, ok: true });
/** A real, passing verification event through the ordinary tool path. */
const verify = (c, command = "npm test") =>
  c.recordToolCall({
    tool: "bash", args: { command }, ok: true,
    output: JSON.stringify({ exit_code: 0, stdout: "# tests 3\n# pass 3\n# fail 0" }),
  });

/** Drive turns until a stop or a directive appears; returns the last verdict. */
function driveUntil(c, turns, stopOn = (v) => v.stop || v.directive) {
  let verdict = { stop: false };
  let n = 0;
  for (const t of turns) {
    n++; t(c);
    verdict = c.endIteration();
    if (stopOn(verdict)) break;
  }
  return { verdict, turnsRun: n };
}

const FILES = ["server/api.mjs", "client/apiClient.mjs", "client/App.mjs"];

/**
 * The observed benchmark shape, faithfully: read all three files (UNDERSTAND),
 * then edit all three (ACT). The reads must come first — that is what makes the
 * later VERIFY re-reads score zero, which is the whole mechanism under test.
 */
function implement(c) {
  for (const f of FILES) { read(c, f); c.endIteration(); }
  for (const f of FILES) { edit(c, f); c.endIteration(); }
}

/** The VERIFY re-reads that follow, none of which learn anything new. */
const selfReview = FILES.map((f) => (c) => read(c, f));

// ── TEST 1 ──────────────────────────────────────────────────────────────────
test("1: a completed implementation that stalls while self-reviewing gets ONE verification reprieve", () => {
  const c = createTaskController({ task: TASK });
  implement(c);

  const { verdict } = driveUntil(c, [...selfReview, (x) => read(x, "package.json")]);

  assert.equal(verdict.stop, false, "the run must not be terminated");
  assert.equal(verdict.directiveKind, "verification_grace");
  assert.match(verdict.directive, /have not verified your changes/);
  assert.match(verdict.directive, /server\/api\.mjs/, "names the files actually edited");
  assert.equal(verdict.noProgressStreak, 0, "the streak resets with the reprieve");
  assert.equal(c.snapshot().verificationGraceUsed, true);
});

// ── TEST 2 ──────────────────────────────────────────────────────────────────
test("2: after the reprieve a real verification event is recorded and completion is possible", () => {
  const c = createTaskController({ task: TASK });
  implement(c);
  driveUntil(c, selfReview);
  assert.equal(c.snapshot().verificationGraceUsed, true, "precondition: reprieve issued");

  // The agent complies.
  verify(c);
  const after = c.endIteration();
  assert.equal(after.stop, false);
  assert.ok(after.reasons.includes("ran verification"), `expected verification credit, got ${after.reasons}`);

  const gate = c.canFinish({ editedPaths: ["server/api.mjs", "client/apiClient.mjs", "client/App.mjs"], responseText: "Done." });
  assert.equal(gate.allowed, true, `finish should be allowed after a real check: ${gate.reason ?? gate.directive}`);
  assert.notEqual(gate.kind, "unverified");
});

// ── TEST 3 ──────────────────────────────────────────────────────────────────
test("3: ignoring the directive consumes the reprieve and still terminates — no infinite loop", () => {
  const c = createTaskController({ task: TASK });
  implement(c);

  let sawGrace = false, sawStop = false, graceCount = 0;
  // Far more turns than the streak needs: if the reprieve could repeat, this loops forever.
  for (let i = 0; i < 40; i++) {
    read(c, "server/api.mjs");           // never verifies — ignores the directive
    const v = c.endIteration();
    if (v.directiveKind === "verification_grace") { sawGrace = true; graceCount++; }
    if (v.stop) { sawStop = true; assert.equal(v.reason, "no_progress"); break; }
  }

  assert.equal(sawGrace, true, "the reprieve should have been offered");
  assert.equal(graceCount, 1, "it must be offered exactly once");
  assert.equal(sawStop, true, "the run must still terminate");
});

// ── TEST 4 ──────────────────────────────────────────────────────────────────
test("4: a task with no meaningful mutations keeps the existing no_progress behaviour", () => {
  const c = createTaskController({ task: "Add a loading skeleton component" });
  let stopped = null;
  for (let i = 0; i < 30; i++) {
    read(c, "app/App.tsx");              // explores, never edits
    const v = c.endIteration();
    assert.notEqual(v.directiveKind, "verification_grace", "no reprieve without mutations");
    if (v.stop) { stopped = v; break; }
  }
  assert.ok(stopped, "must still stop");
  assert.equal(stopped.reason, "no_progress");
  assert.equal(c.snapshot().verificationGraceUsed, false);
  assert.match(c.blockerReport(), /without making any change to the workspace/);
});

// ── TEST 5 ──────────────────────────────────────────────────────────────────
test("5: no reprieve is issued when valid verification already exists", () => {
  const c = createTaskController({ task: TASK });
  implement(c);
  verify(c);                              // checked before going idle
  c.endIteration();

  let stopped = null;
  for (let i = 0; i < 30; i++) {
    read(c, "server/api.mjs");
    const v = c.endIteration();
    assert.notEqual(v.directiveKind, "verification_grace", "already verified — nothing to ask for");
    if (v.stop) { stopped = v; break; }
  }
  assert.ok(stopped, "must still stop");
  assert.equal(c.snapshot().verificationGraceUsed, false);
});

// ── TEST 6 ──────────────────────────────────────────────────────────────────
test("6: repeated stalls after the reprieve never yield a second one", () => {
  const c = createTaskController({ task: TASK });
  implement(c);
  driveUntil(c, selfReview);
  assert.equal(c.snapshot().verificationGraceUsed, true);

  // Make more progress, then stall again — the reprieve must not come back.
  edit(c, "client/extra.mjs");
  c.endIteration();
  let second = 0, stopped = false;
  for (let i = 0; i < 30; i++) {
    read(c, "server/api.mjs");
    const v = c.endIteration();
    if (v.directiveKind === "verification_grace") second++;
    if (v.stop) { stopped = true; break; }
  }
  assert.equal(second, 0, "the reprieve is one-shot per run");
  assert.equal(stopped, true);
});

// ── TEST 7 ──────────────────────────────────────────────────────────────────
test("7: the existing discovery_grace reprieve is unchanged", () => {
  const c = createTaskController({ task: "resume the partial command palette implementation" });
  const { verdict } = driveUntil(c, [
    (x) => read(x, "app/App.tsx"), (x) => read(x, "app/App.tsx"),
    (x) => read(x, "app/App.tsx"), (x) => read(x, "app/App.tsx"),
  ]);
  assert.equal(verdict.stop, false, "the first stall must not end the task");
  assert.equal(verdict.directiveKind, "discovery_grace");
  assert.match(verdict.directive, /not learning anything new/);
  assert.equal(verdict.noProgressStreak, 0);
  assert.equal(c.snapshot().discoveryGraceUsed, true);
  assert.equal(c.snapshot().verificationGraceUsed, false, "discovery stalls must not consume the verification reprieve");
});

// ── The reprieve asks; it never satisfies ───────────────────────────────────
test("8: the reprieve does not itself count as verification, and evidence rules still apply", () => {
  const c = createTaskController({ task: TASK });
  implement(c);
  driveUntil(c, selfReview);
  assert.equal(c.snapshot().verificationGraceUsed, true, "precondition: reprieve issued");

  // The finish gate must STILL demand verification — the directive proved nothing.
  const gate = c.canFinish({ editedPaths: ["server/api.mjs"], responseText: "All done." });
  assert.equal(gate.allowed, false, "an unverified run must not be allowed to finish");
  assert.equal(gate.kind, "unverified");

  // And a masked command still fails to satisfy it.
  c.recordToolCall({
    tool: "bash", args: { command: "npm test || echo 'no test script'" }, ok: true,
    output: JSON.stringify({ exit_code: 0, stdout: "no test script" }),
  });
  c.endIteration();
  const after = c.canFinish({ editedPaths: ["server/api.mjs"], responseText: "All done." });
  assert.notEqual(after.allowed && !after.unverified, true,
    "a ||-masked command must not certify the workspace");
});
