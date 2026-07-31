/**
 * tests/conversationStore.test.mjs
 * Run with: node tests/conversationStore.test.mjs
 *
 * Covers the replay engine that rebuilds the agent's tool-loop conversation
 * from persisted turn_events: message shape fidelity, tool_call pairing
 * (a dangling call is a hard provider error), value-ordered compaction,
 * pinned-row survival, and observation dedup.
 */

import assert from "assert";

import {
  buildConversationFromEvents,
  repairToolPairing,
  dedupeObservations,
} from "../services/conversationStore.mjs";

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

const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function turn({ kind, content = null, toolCalls = null, toolCallId = null, toolName = null, toolArgs = null, status = null, pinned = 0 }) {
  return {
    kind, content,
    tool_calls: toolCalls ? JSON.stringify(toolCalls) : null,
    tool_call_id: toolCallId,
    tool_name: toolName,
    tool_args: toolArgs ? JSON.stringify(toolArgs) : null,
    status, pinned,
  };
}

// A complete, well-formed turn: user → assistant(read) → result → assistant text
const HAPPY = [
  turn({ kind: "user", content: "add auth" }),
  turn({ kind: "assistant", content: "", toolCalls: [call("c1", "read_file", { path: "src/auth.ts" })] }),
  turn({ kind: "tool", toolCallId: "c1", toolName: "read_file", toolArgs: { path: "src/auth.ts" }, content: "uses JWT middleware", status: "ok" }),
  turn({ kind: "assistant", content: "Auth uses JWT." }),
];

console.log("\n📦 buildConversationFromEvents (replay)");

test("empty / missing history replays as nothing (first turn unchanged)", () => {
  assert.deepStrictEqual(buildConversationFromEvents([]), []);
  assert.deepStrictEqual(buildConversationFromEvents(null), []);
});

test("a full turn replays with exact chat shape and order", () => {
  const out = buildConversationFromEvents(HAPPY);
  assert.deepStrictEqual(out.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.strictEqual(out[1].tool_calls[0].function.name, "read_file");
  assert.strictEqual(out[2].tool_call_id, "c1");
  assert.strictEqual(out[2].content, "uses JWT middleware");
});

test("tool RESULT payloads survive verbatim inside the recent window", () => {
  const out = buildConversationFromEvents(HAPPY);
  assert.ok(out.some((m) => m.role === "tool" && m.content.includes("JWT middleware")));
});

test("a trailing UNANSWERED user turn is dropped (aborted run must not look resumable)", () => {
  const out = buildConversationFromEvents([...HAPPY, turn({ kind: "user", content: "aborted request" })]);
  assert.ok(!out.some((m) => m.role === "user" && m.content === "aborted request"));
});

test("history of only an unanswered user turn collapses to empty", () => {
  assert.deepStrictEqual(buildConversationFromEvents([turn({ kind: "user", content: "hi" })]), []);
});

test("a FAILED tool keeps its failure visible (previous attempts must be remembered)", () => {
  const events = [
    turn({ kind: "user", content: "install" }),
    turn({ kind: "assistant", content: "", toolCalls: [call("b1", "bash", { command: "pip install -e ." })] }),
    turn({ kind: "tool", toolCallId: "b1", toolName: "bash", toolArgs: { command: "pip install -e ." }, content: "ERROR: requires Python >=3.10", status: "error" }),
    turn({ kind: "assistant", content: "That failed." }),
  ];
  const out = buildConversationFromEvents(events);
  const toolMsg = out.find((m) => m.role === "tool");
  assert.ok(/Python >=3\.10/.test(toolMsg.content), "failure detail must survive");
});

console.log("\n📦 compaction (value-ordered, not age-only)");

test("old tool payloads compress to a receipt that still names the tool and target", () => {
  const events = [turn({ kind: "user", content: "start" })];
  for (let i = 0; i < 60; i++) {
    events.push(turn({ kind: "assistant", content: "", toolCalls: [call(`c${i}`, "read_file", { path: `f${i}.ts` })] }));
    events.push(turn({ kind: "tool", toolCallId: `c${i}`, toolName: "read_file", toolArgs: { path: `f${i}.ts` }, content: "X".repeat(3000), status: "ok" }));
  }
  events.push(turn({ kind: "assistant", content: "done" }));

  // Generous budget so ONLY the recent-window compression applies — the digest
  // collapse is a separate stage, covered by its own test below.
  const out = buildConversationFromEvents(events, { charBudget: Number.MAX_SAFE_INTEGER });
  const oldTool = out.find((m) => m.role === "tool" && m.content.includes("read_file(f0.ts)"));
  assert.ok(oldTool, "old tool call must still be present as a receipt");
  assert.ok(oldTool.content.length < 300, "old payload should be compressed");
  assert.ok(!oldTool.content.includes("X".repeat(500)), "bulk payload must be gone");
});

test("recent tool payloads are NOT compressed", () => {
  const events = [turn({ kind: "user", content: "start" })];
  for (let i = 0; i < 60; i++) {
    events.push(turn({ kind: "assistant", content: "", toolCalls: [call(`c${i}`, "read_file", { path: `f${i}.ts` })] }));
    events.push(turn({ kind: "tool", toolCallId: `c${i}`, toolName: "read_file", toolArgs: { path: `f${i}.ts` }, content: `PAYLOAD_${i}`, status: "ok" }));
  }
  const out = buildConversationFromEvents(events);
  assert.ok(out.some((m) => m.role === "tool" && m.content === "PAYLOAD_59"), "newest payload must be verbatim");
});

test("PINNED rows survive compaction even from the oldest range", () => {
  const events = [
    turn({ kind: "user", content: "ARCHITECTURE: use Postgres, not Mongo", pinned: 1 }),
  ];
  for (let i = 0; i < 80; i++) {
    events.push(turn({ kind: "assistant", content: `filler ${i} `.repeat(80) }));
  }
  const out = buildConversationFromEvents(events, { charBudget: 2_000 });
  assert.ok(
    out.some((m) => String(m.content).includes("use Postgres")),
    "pinned architecture decision must never be compacted away",
  );
});

test("a PINNED tool result survives even when its parent call is collapsed away", () => {
  // The pinned todo has no surviving assistant call, so pairing repair would
  // drop it as an orphan — the pin must win anyway.
  const events = [
    turn({ kind: "tool", toolCallId: "orphan", toolName: "todo_write", toolArgs: {}, content: "1. migrate to Postgres", status: "ok", pinned: 1 }),
  ];
  for (let i = 0; i < 80; i++) events.push(turn({ kind: "assistant", content: `noise ${i} `.repeat(60) }));

  const out = buildConversationFromEvents(events, { charBudget: 1_500 });
  assert.ok(
    out.some((m) => String(m.content).includes("migrate to Postgres")),
    "pinned plan must survive even when unpairable",
  );
  const ids = new Set(out.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const m of out) {
    for (const tc of m.tool_calls || []) assert.ok(ids.has(tc.id), "must stay provider-legal");
  }
});

test("over-budget history collapses oldest into a digest that still lists what ran", () => {
  const events = [turn({ kind: "user", content: "big task" })];
  for (let i = 0; i < 80; i++) {
    events.push(turn({ kind: "assistant", content: "", toolCalls: [call(`c${i}`, "edit_file", { path: `f${i}.ts` })] }));
    events.push(turn({ kind: "tool", toolCallId: `c${i}`, toolName: "edit_file", toolArgs: { path: `f${i}.ts` }, content: "ok", status: "ok" }));
  }
  const out = buildConversationFromEvents(events, { charBudget: 3_000 });
  const digest = out.find((m) => String(m.content).startsWith("[Earlier in this session:"));
  assert.ok(digest, "a digest line must be produced");
  assert.ok(/edit_file/.test(digest.content), "digest must retain which tools ran");
});

console.log("\n📦 tool_call pairing (a dangling call is a hard provider error)");

test("an assistant call with no result is repaired, not emitted dangling", () => {
  const out = repairToolPairing([
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [call("missing", "read_file", { path: "x" })] },
  ]);
  assert.ok(!out.some((m) => m.tool_calls?.length), "no unpaired tool_calls may remain");
  assert.ok(out.some((m) => /result no longer in context/.test(String(m.content))), "the fact it ran is preserved");
});

test("an orphaned tool result (call already evicted) is dropped", () => {
  const out = repairToolPairing([
    { role: "user", content: "go" },
    { role: "tool", tool_call_id: "ghost", content: "orphan" },
  ]);
  assert.ok(!out.some((m) => m.role === "tool"), "orphan result must not survive");
});

test("partially-paired batch keeps the paired call and reports the dropped one", () => {
  const out = repairToolPairing([
    { role: "assistant", content: "", tool_calls: [call("keep", "read_file", { path: "a" }), call("lost", "grep", { pattern: "b" })] },
    { role: "tool", tool_call_id: "keep", content: "ok" },
  ]);
  const asst = out.find((m) => m.role === "assistant");
  assert.strictEqual(asst.tool_calls.length, 1);
  assert.strictEqual(asst.tool_calls[0].id, "keep");
  assert.ok(/grep/.test(asst.content), "dropped call should be named in text");
});

test("truncated history never yields an unpaired call (fuzz over cut points)", () => {
  const events = [turn({ kind: "user", content: "start" })];
  for (let i = 0; i < 30; i++) {
    events.push(turn({ kind: "assistant", content: "", toolCalls: [call(`c${i}`, "read_file", { path: `f${i}` })] }));
    events.push(turn({ kind: "tool", toolCallId: `c${i}`, toolName: "read_file", toolArgs: { path: `f${i}` }, content: "data", status: "ok" }));
  }
  for (let cut = 1; cut < events.length; cut++) {
    const out = buildConversationFromEvents(events.slice(0, cut), { charBudget: 1_500, recentVerbatim: 5 });
    const ids = new Set(out.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (const m of out) {
      for (const tc of m.tool_calls || []) {
        assert.ok(ids.has(tc.id), `cut=${cut}: dangling tool_call ${tc.id}`);
      }
    }
  }
});

console.log("\n📦 dedupeObservations");

test("repeated identical reads collapse to a pointer, newest kept verbatim", () => {
  const events = [
    turn({ kind: "tool", toolCallId: "a", toolName: "read_file", toolArgs: { path: "a.ts" }, content: "V1", status: "ok" }),
    turn({ kind: "tool", toolCallId: "b", toolName: "read_file", toolArgs: { path: "a.ts" }, content: "V2", status: "ok" }),
  ];
  const out = dedupeObservations(events);
  assert.ok(/superseded/.test(out[0].content), "earlier duplicate should point forward");
  assert.strictEqual(out[1].content, "V2", "latest read stays verbatim");
});

test("repeated bash/edit calls are NOT deduped (they are real events, not redundancy)", () => {
  const events = [
    turn({ kind: "tool", toolCallId: "a", toolName: "bash", toolArgs: { command: "npm test" }, content: "fail", status: "error" }),
    turn({ kind: "tool", toolCallId: "b", toolName: "bash", toolArgs: { command: "npm test" }, content: "pass", status: "ok" }),
  ];
  const out = dedupeObservations(events);
  assert.strictEqual(out[0].content, "fail", "an earlier failing run must stay visible");
});

test("reads of DIFFERENT files are untouched", () => {
  const events = [
    turn({ kind: "tool", toolCallId: "a", toolName: "read_file", toolArgs: { path: "a.ts" }, content: "A", status: "ok" }),
    turn({ kind: "tool", toolCallId: "b", toolName: "read_file", toolArgs: { path: "b.ts" }, content: "B", status: "ok" }),
  ];
  const out = dedupeObservations(events);
  assert.deepStrictEqual(out.map((e) => e.content), ["A", "B"]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
