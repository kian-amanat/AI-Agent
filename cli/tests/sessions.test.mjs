/**
 * tests/sessions.test.mjs
 * Run with: node tests/sessions.test.mjs
 *
 * Session persistence and event translation. The important property here is
 * that CLI sessions record events in the SAME shape backend1's turn_events
 * table uses, so core's own conversation replay — tool-call pairing repair,
 * value-based compaction — works on them unchanged. If that shape ever drifts,
 * a CLI session silently loses its working memory, and these tests are what
 * catches it.
 */

import { assert, test, section, finish, withTempHome } from "./harness.mjs";
import * as sessions from "../src/sessions.mjs";
import { toPublicEvent, EVENT } from "../src/events.mjs";
import { loadCore } from "../src/core.mjs";

section("session store");

await test("create → load → list round-trips", withTempHome(async () => {
  sessions.ensureStore();
  const created = sessions.createSession({ workspace: "/tmp/project", title: "fix the thing" });
  const loaded = sessions.load(created.id);
  assert.strictEqual(loaded.id, created.id);
  assert.strictEqual(loaded.workspace, "/tmp/project");
  assert.strictEqual(sessions.list().length, 1);
}));

await test("a session resolves by its short handle, the way `kodo resume a82f` does",
  withTempHome(async () => {
    sessions.ensureStore();
    const created = sessions.createSession({ workspace: "/tmp/p" });
    const short = sessions.shortId(created.id);
    assert.strictEqual(short.length, 6);
    assert.strictEqual(sessions.load(short)?.id, created.id);
  }));

await test("remove deletes, and reports honestly when there is nothing to delete",
  withTempHome(async () => {
    sessions.ensureStore();
    const created = sessions.createSession({ workspace: "/tmp/p" });
    assert.strictEqual(sessions.remove(created.id), true);
    assert.strictEqual(sessions.load(created.id), null);
    assert.strictEqual(sessions.remove("nope"), false);
  }));

await test("listing is newest-first", withTempHome(async () => {
  sessions.ensureStore();
  const first = sessions.createSession({ workspace: "/a" });
  await new Promise((r) => setTimeout(r, 10));
  const second = sessions.createSession({ workspace: "/b" });
  assert.strictEqual(sessions.list()[0].id, second.id);
  assert.strictEqual(sessions.list()[1].id, first.id);
}));

await test("recorded events use the turn_events column shape core replays from",
  withTempHome(async () => {
    sessions.ensureStore();
    const session = sessions.createSession({ workspace: "/tmp/p" });

    sessions.recordEvent(session, { kind: "user", content: "fix the bug" });
    sessions.recordEvent(session, {
      kind: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }],
    });
    sessions.recordEvent(session, {
      kind: "tool", toolCallId: "call_1", toolName: "read_file",
      toolArgs: '{"path":"a.js"}', content: "file contents", status: "ok",
    });

    const [user, assistantEvent, tool] = session.events;
    assert.strictEqual(user.kind, "user");
    // snake_case columns, tool_calls serialised as JSON — exactly what
    // db.mjs's appendTurnEvent writes and conversationStore reads.
    assert.strictEqual(typeof assistantEvent.tool_calls, "string");
    assert.strictEqual(tool.tool_call_id, "call_1");
    assert.strictEqual(tool.tool_name, "read_file");
    assert.ok("duration_ms" in tool && "created_at" in tool && "pinned" in tool);
  }));

await test("core rebuilds a well-formed conversation from a CLI session",
  withTempHome(async () => {
    sessions.ensureStore();
    const core = await loadCore();
    const session = sessions.createSession({ workspace: "/tmp/p" });

    sessions.recordEvent(session, { kind: "user", content: "fix the bug" });
    sessions.recordEvent(session, {
      kind: "assistant", content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } }],
    });
    sessions.recordEvent(session, {
      kind: "tool", toolCallId: "call_1", toolName: "read_file", content: "contents", status: "ok",
    });
    sessions.recordEvent(session, { kind: "assistant", content: "Fixed it." });

    const conversation = await sessions.priorConversation(core, session);
    assert.ok(conversation.length >= 3, "the timeline should replay, not collapse");
    assert.strictEqual(conversation[0].role, "user");

    // The invariant a provider will 400 on if broken: every assistant tool_call
    // must have a matching tool result.
    const callIds = conversation.flatMap((m) => (m.tool_calls || []).map((c) => c.id));
    const resultIds = conversation.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    for (const id of callIds) {
      assert.ok(resultIds.includes(id), `tool_call ${id} must be paired with a result`);
    }
  }));

await test("a severed tool pair is repaired rather than replayed broken",
  withTempHome(async () => {
    sessions.ensureStore();
    const core = await loadCore();
    const session = sessions.createSession({ workspace: "/tmp/p" });

    sessions.recordEvent(session, { kind: "user", content: "do it" });
    // An assistant tool_call whose result never arrived — what a run killed
    // mid-flight leaves behind.
    sessions.recordEvent(session, {
      kind: "assistant", content: "",
      toolCalls: [{ id: "orphan", type: "function", function: { name: "bash", arguments: "{}" } }],
    });

    const conversation = await sessions.priorConversation(core, session);
    const orphans = conversation.flatMap((m) => (m.tool_calls || []).map((c) => c.id));
    assert.ok(!orphans.includes("orphan"),
      "an unpaired tool_call must be repaired away — replaying it is a hard provider error");
  }));

await test("event history stays bounded on a long session", withTempHome(async () => {
  sessions.ensureStore();
  const session = sessions.createSession({ workspace: "/tmp/p" });
  for (let i = 0; i < 600; i++) sessions.recordEvent(session, { kind: "user", content: `turn ${i}` });
  sessions.save(session);
  const reloaded = sessions.load(session.id);
  assert.ok(reloaded.events.length <= 400, `expected a bounded window, got ${reloaded.events.length}`);
  // The window keeps the NEWEST events.
  assert.ok(reloaded.events[reloaded.events.length - 1].content.includes("599"));
}));

await test("oversized content is truncated rather than written whole", withTempHome(async () => {
  sessions.ensureStore();
  const session = sessions.createSession({ workspace: "/tmp/p" });
  sessions.recordEvent(session, { kind: "tool", content: "x".repeat(100_000) });
  assert.ok(session.events[0].content.length < 30_000);
  assert.ok(session.events[0].content.includes("truncated"));
}));

section("agent event translation");

await test("internal emits map onto the public event vocabulary", () => {
  assert.deepStrictEqual(toPublicEvent({ type: "content", content: "hi" }),
    { type: EVENT.AGENT_MESSAGE, text: "hi" });

  const progress = toPublicEvent({ type: "progress", stage: "exploring", message: "read a.js" });
  assert.strictEqual(progress.type, EVENT.AGENT_PROGRESS);
  assert.strictEqual(progress.stage, "exploring");

  const file = toPublicEvent({ type: "file_diff", action: "create", path: "a.js", hunks: [1, 2] });
  assert.strictEqual(file.type, EVENT.FILE_CHANGED);
  assert.strictEqual(file.path, "a.js");
  assert.strictEqual(file.hunks, 2, "hunks should be summarised to a count, not shipped whole");

  assert.strictEqual(toPublicEvent({ type: "todo", todos: [] }).type, EVENT.TODO_UPDATED);
  assert.strictEqual(toPublicEvent({ type: "error", error: "boom" }).type, EVENT.AGENT_ERROR);
});

await test("unknown or malformed emits are dropped, never forwarded raw", () => {
  assert.strictEqual(toPublicEvent({ type: "something_internal" }), null);
  assert.strictEqual(toPublicEvent(null), null);
  assert.strictEqual(toPublicEvent("not an object"), null);
  assert.strictEqual(toPublicEvent(undefined), null);
});

finish();
