/**
 * tests/e2e.test.mjs
 * Run with: node tests/e2e.test.mjs
 *
 * The scenario from the CLI spec, end to end:
 *
 *   start on port 0 → discover the port → /health → create a session →
 *   send a request → receive streaming events → cancel → stop → verify exit.
 *
 * The agent step needs a real model, so it is gated: with credentials the full
 * chain runs, without them the transport half still runs and the agent step
 * reports as skipped. It never silently passes while testing nothing.
 *
 * Cleanup is unconditional — a failed assertion must not leave a server running
 * or a temp directory behind.
 */

import fs from "fs";
import path from "path";

import {
  assert, test, section, finish, withTempHome, tempWorkspace, waitFor, sleep,
} from "./harness.mjs";
import * as lifecycle from "../src/runtime/lifecycle.mjs";
import * as state from "../src/runtime/state.mjs";
import { identityMatches } from "../src/runtime/identity.mjs";
import { runtimeDir } from "../src/paths.mjs";

const HAVE_CREDENTIALS = Boolean(process.env.OPENAI_API_KEY && process.env.DEFAULT_MODEL);

const MODEL_ROUTE = HAVE_CREDENTIALS
  ? {
      ok: true,
      model: process.env.DEFAULT_MODEL,
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    }
  : { ok: true, model: "unconfigured", apiKey: "none", baseUrl: "http://127.0.0.1:1" };

/** Collect SSE events until `predicate` matches or the budget runs out. */
async function collectEvents(url, { untilType, timeoutMs = 180_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop();
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (event.type === untilType) {
          // Release the reader before aborting: tearing the socket out from
          // under an in-flight read is what surfaces as an opaque "terminated"
          // error instead of a clean stop.
          await reader.cancel().catch(() => {});
          controller.abort();
          return events;
        }
      }
    }
    return events;
  } catch (err) {
    // An intentional abort surfaces differently depending on where in the
    // stream it lands: AbortError from fetch, or undici's "terminated"
    // TypeError from the body reader. Both mean "we stopped on purpose".
    if (err.name === "AbortError" || /terminated|aborted/i.test(err.message)) return events;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

section("E2E — full server lifecycle and API contract");

await test("the whole scenario, cleaning up even if it fails", withTempHome(async () => {
  const workspace = tempWorkspace({
    "calc.js": "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n",
    "README.md": "# fixture\n",
  });

  let started = null;
  try {
    // 1. Start on port 0.
    started = await lifecycle.start({
      name: "ui", host: "127.0.0.1", port: 0,
      workspace, modelRoute: MODEL_ROUTE, permissionMode: "auto", detach: true,
    });
    assert.ok(started.started, "the server should have started");

    // 2. Discover the assigned port from the runtime record.
    const record = JSON.parse(fs.readFileSync(path.join(runtimeDir(), "ui.json"), "utf-8"));
    assert.ok(record.port > 0, "the assigned port must be discoverable from runtime state");
    const base = `http://127.0.0.1:${record.port}`;
    const auth = { Authorization: `Bearer ${started.token}`, "Content-Type": "application/json" };

    // 3. /health, and prove the process is the one our state file describes.
    const health = await (await fetch(`${base}/health`)).json();
    assert.strictEqual(health.status, "ok");
    assert.ok(identityMatches(started.token, health.identity));

    // 3b. The API is closed without the token.
    const unauthorised = await fetch(`${base}/api/status`);
    assert.strictEqual(unauthorised.status, 401, "the API must be closed to unauthenticated callers");

    // 3c. …and closed to a browser page from another origin.
    const crossOrigin = await fetch(`${base}/api/status`, {
      headers: { ...auth, Origin: "https://attacker.example" },
    });
    assert.strictEqual(crossOrigin.status, 403, "cross-origin browser traffic must be refused");

    // 4. Create a session.
    const created = await (await fetch(`${base}/api/sessions`, {
      method: "POST", headers: auth, body: JSON.stringify({ title: "e2e" }),
    })).json();
    assert.ok(created.ok && created.session.id, "a session should be created");
    const sessionId = created.session.id;

    const listed = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
    assert.ok(listed.sessions.some((s) => s.id === sessionId));

    // 5-7. The agent leg. Only meaningful with a real model.
    if (!HAVE_CREDENTIALS) {
      console.log("     ↳ agent leg skipped: set OPENAI_API_KEY and DEFAULT_MODEL to exercise it");
    } else {
      const accepted = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ message: "Read calc.js and reply with only the word DONE. Change nothing." }),
      });
      assert.strictEqual(accepted.status, 202, "a message should be accepted for background execution");

      const events = await collectEvents(
        `${base}/api/sessions/${sessionId}/events?token=${started.token}`,
        { untilType: "session_completed" },
      );

      assert.ok(events.length > 0, "the stream should deliver events");
      assert.ok(events.some((e) => e.type === "session_started"), "expected a session_started event");
      assert.ok(
        events.some((e) => e.type === "agent_message" || e.type === "agent_progress"),
        "expected the agent to say or do something",
      );
      assert.ok(events.some((e) => e.type === "session_completed"), "expected the run to complete");

      // A busy session refuses a concurrent second message rather than
      // interleaving two agent runs over the same files.
      const busySession = await (await fetch(`${base}/api/sessions`, {
        method: "POST", headers: auth, body: "{}",
      })).json();
      await fetch(`${base}/api/sessions/${busySession.session.id}/messages`, {
        method: "POST", headers: auth, body: JSON.stringify({ message: "list the files here" }),
      });
      const second = await fetch(`${base}/api/sessions/${busySession.session.id}/messages`, {
        method: "POST", headers: auth, body: JSON.stringify({ message: "and again" }),
      });
      assert.strictEqual(second.status, 409, "a second concurrent run in one session must be refused");

      // 8. Cancel it.
      const cancelled = await (await fetch(`${base}/api/sessions/${busySession.session.id}/cancel`, {
        method: "POST", headers: auth,
      })).json();
      assert.ok(cancelled.ok);
    }

    // 9. Stop the server and verify the process really exited.
    const pid = record.pid;
    const stopResult = await lifecycle.stop("ui");
    started = null;
    assert.strictEqual(stopResult.stopped, true, "stop() should report success");
    await waitFor(() => !state.pidAlive(pid), { what: "the server process to exit" });
    assert.ok(!fs.existsSync(path.join(runtimeDir(), "ui.json")), "runtime state should be gone");

    const gone = await state.probeHealth("127.0.0.1", record.port, { timeoutMs: 1000 });
    assert.strictEqual(gone, null, "nothing should answer on the port any more");
  } finally {
    // Unconditional: a failed assertion above must not leave a server running.
    await lifecycle.stop("ui").catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}));

finish();
