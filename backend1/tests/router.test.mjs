/**
 * tests/router.test.mjs
 * Run with: node tests/router.test.mjs
 *
 * Covers the answer-vs-agent fast-path classifier in router.mjs. The bug this
 * guards against: "how can I run my frontend server on port 5432?" used to be
 * force-routed to "answer" mode (no bash/read_file tools at all) purely
 * because it's phrased as a question — producing a generic, framework-agnostic
 * cheat sheet instead of an agent that could read package.json and actually
 * run the right command. classifyFastPath is network-free (no LLM call), so
 * these run fast and deterministically.
 */

import assert from "assert";
import { classifyFastPath } from "../agents/nodes/router.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

console.log("\n📦 classifyFastPath — action-flavored questions escape the question fast-path");

test('"how can I run front server on port 5432?" is NOT force-answered (falls through to null → LLM/agent)', () => {
  assert.strictEqual(classifyFastPath("how can i run front server on port 5432?"), null);
});

test("other action-flavored \"how/what\" questions also fall through", () => {
  for (const msg of [
    "how do I start the dev server?",
    "how can I deploy this to production?",
    "what command do I use to install the dependencies?",
  ]) {
    assert.strictEqual(classifyFastPath(msg), null, `expected null for: "${msg}"`);
  }
  // "how do I build THIS PROJECT?" now resolves locally to "agent" rather than
  // null: it names the project, so isWorkspaceQuery settles it without an LLM
  // call. The guarantee this test exists to protect — never force-answered —
  // holds either way, so it is asserted directly.
  assert.notStrictEqual(classifyFastPath("how do I build this project?"), "answer");
});

console.log("\n📦 classifyFastPath — regression: unaffected fast-paths still resolve locally");

test("pure conceptual questions with no action language still auto-answer (no LLM call needed)", () => {
  assert.strictEqual(classifyFastPath("what is a closure in JavaScript?"), "answer");
  assert.strictEqual(classifyFastPath("why does React re-render on state change?"), "answer");
  assert.strictEqual(classifyFastPath("how does JWT authentication work?"), "answer");
});

test("greetings and no-action requests still answer directly", () => {
  assert.strictEqual(classifyFastPath("hello"), "answer");
  assert.strictEqual(classifyFastPath("just tell me what this function does"), "answer");
});

test("obvious edit/build requests still route to agent", () => {
  assert.strictEqual(classifyFastPath("fix the bug in the navbar component"), "agent");
  assert.strictEqual(classifyFastPath("add a feedback form to the page"), "agent");
  assert.strictEqual(classifyFastPath("i want the login button to have an animation"), "agent");
  assert.strictEqual(classifyFastPath("go ahead and apply that"), "agent");
});

test("empty message defaults to answer", () => {
  assert.strictEqual(classifyFastPath(""), "answer");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
