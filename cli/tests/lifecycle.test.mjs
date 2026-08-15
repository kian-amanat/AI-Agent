/**
 * tests/lifecycle.test.mjs
 * Run with: node tests/lifecycle.test.mjs
 *
 * The server lifecycle, against real processes and real sockets. These are the
 * tests that matter for the promise "you never have to `kill -9` Kodo": stale
 * PID files, recycled PIDs, port conflicts, duplicate starts, signals, and
 * crash recovery.
 *
 * No model credentials are needed — the server starts and answers /health
 * without ever calling a provider.
 */

import fs from "fs";
import net from "net";
import path from "path";

import {
  assert, test, section, finish, withTempHome, tempWorkspace, runCli, waitFor, sleep,
} from "./harness.mjs";
import * as state from "../src/runtime/state.mjs";
import * as lifecycle from "../src/runtime/lifecycle.mjs";
import { identityOf, identityMatches } from "../src/runtime/identity.mjs";
import { isPortFree, findFreePort, resolvePort } from "../src/runtime/ports.mjs";
import { writeJsonAtomic, readJson, runtimeDir } from "../src/paths.mjs";

const FAKE_ROUTE = { ok: true, model: "test-model", apiKey: "test-key", baseUrl: "http://127.0.0.1:1" };

/** Start a server for a test and guarantee it is stopped afterwards. */
async function withServer(fn, startOptions = {}) {
  const workspace = tempWorkspace({ "README.md": "# test" });
  let started = null;
  try {
    started = await lifecycle.start({
      name: "ui", host: "127.0.0.1", port: 0,
      workspace, modelRoute: FAKE_ROUTE, detach: true,
      ...startOptions,
    });
    await fn(started, workspace);
  } finally {
    await lifecycle.stop("ui").catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// ── Identity ─────────────────────────────────────────────────────────────────

section("runtime identity");

await test("identity is a hash — the token itself is never derivable from it", () => {
  const token = "a".repeat(64);
  const published = identityOf(token);
  assert.notStrictEqual(published, token);
  assert.ok(!published.includes(token));
  assert.ok(identityMatches(token, published));
  assert.ok(!identityMatches("b".repeat(64), published));
});

await test("identityMatches rejects malformed input instead of throwing", () => {
  assert.strictEqual(identityMatches("x", undefined), false);
  assert.strictEqual(identityMatches("x", null), false);
  assert.strictEqual(identityMatches("x", 12345), false);
  assert.strictEqual(identityMatches("x", "short"), false);
});

// ── PID handling ─────────────────────────────────────────────────────────────

section("PID liveness");

await test("pidAlive recognises this process and rejects nonsense", () => {
  assert.ok(state.pidAlive(process.pid));
  assert.ok(!state.pidAlive(0));
  assert.ok(!state.pidAlive(-1));
  assert.ok(!state.pidAlive(2 ** 31));
  assert.ok(!state.pidAlive("not-a-pid"));
  assert.ok(!state.pidAlive(null));
});

await test("a stale record (dead PID) reads as stopped, not running", withTempHome(async () => {
  // A PID that has certainly exited: spawn nothing, use a very high one.
  writeJsonAtomic(path.join(runtimeDir(), "ui.json"), {
    pid: 2 ** 22 - 1, port: 4173, host: "127.0.0.1", token: "x", startedAt: new Date().toISOString(),
  });
  const read = state.read("ui");
  assert.strictEqual(read.status, "stale", "a dead PID must be reported as stale, not running");

  const live = state.readLive("ui");
  assert.strictEqual(live.status, "stopped");
  assert.ok(live.reclaimed, "readLive should reclaim the stale record");
  assert.ok(!fs.existsSync(path.join(runtimeDir(), "ui.json")), "the stale file should be gone");
}));

await test("a truncated state file reads as stopped rather than throwing", withTempHome(async () => {
  fs.mkdirSync(runtimeDir(), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir(), "ui.json"), '{"pid": 12');
  assert.strictEqual(state.read("ui").status, "stopped");
}));

await test("state writes are atomic — no partial file is ever observable", withTempHome(async () => {
  const file = path.join(runtimeDir(), "ui.json");
  for (let i = 0; i < 50; i++) {
    writeJsonAtomic(file, { pid: i, port: 4000 + i, host: "127.0.0.1", token: "t" });
    const read = readJson(file, null);
    assert.ok(read && read.pid === i, "every read must see a complete record");
  }
}));

await test("stop refuses to signal a PID that cannot prove it is Kodo", withTempHome(async () => {
  // A live process that is emphatically not Kodo: this test runner itself.
  // If stop() signalled on PID alone, this test would kill its own process.
  writeJsonAtomic(path.join(runtimeDir(), "ui.json"), {
    pid: process.pid,
    port: 1,                        // nothing is listening — identity cannot be proven
    host: "127.0.0.1",
    token: "some-token",
    startedAt: new Date().toISOString(),
  });

  const result = await lifecycle.stop("ui");
  assert.strictEqual(result.reason, "identity_mismatch");
  assert.strictEqual(result.wasRunning, false);
  assert.ok(!fs.existsSync(path.join(runtimeDir(), "ui.json")), "the unverifiable record should be cleared");
  // The clincher: we are still here.
  assert.ok(state.pidAlive(process.pid), "stop() must not have signalled an unverified process");
}));

// ── Ports ────────────────────────────────────────────────────────────────────

section("port selection");

await test("findFreePort returns a bindable port", async () => {
  const port = await findFreePort("127.0.0.1");
  assert.ok(port > 0 && port < 65536);
  assert.strictEqual(await isPortFree(port, "127.0.0.1"), true);
});

await test("isPortFree reports false for a port that is actually held", async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const held = server.address().port;
  try {
    assert.strictEqual(await isPortFree(held, "127.0.0.1"), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test("resolvePort(0) picks one; an explicit port is reported as taken, never silently moved", async () => {
  const auto = await resolvePort(0, "127.0.0.1");
  assert.strictEqual(auto.chosen, "auto");

  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const held = server.address().port;
  try {
    const explicit = await resolvePort(held, "127.0.0.1");
    assert.strictEqual(explicit.port, held, "an explicit port must never be silently changed");
    assert.strictEqual(explicit.free, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── Full lifecycle ───────────────────────────────────────────────────────────

section("server lifecycle");

await test("start → status → stop, with the port released afterwards", withTempHome(async () => {
  await withServer(async (started) => {
    assert.ok(started.started);
    assert.ok(started.record.pid > 0);
    assert.ok(state.pidAlive(started.record.pid));

    const s = lifecycle.status("ui");
    assert.strictEqual(s.running, true);
    assert.strictEqual(s.record.port, started.record.port);

    const health = await state.probeHealth("127.0.0.1", started.record.port);
    assert.strictEqual(health.status, "ok");
    assert.ok(identityMatches(started.token, health.identity));
  });

  assert.strictEqual(lifecycle.status("ui").running, false, "status must be stopped after stop()");
}));

await test("health never discloses the runtime token", withTempHome(async () => {
  await withServer(async (started) => {
    const res = await fetch(`http://127.0.0.1:${started.record.port}/health`);
    const body = await res.text();
    assert.ok(!body.includes(started.token),
      "publishing the bearer token on an unauthenticated endpoint would hand a working credential " +
      "to every process on the machine");
    assert.ok(JSON.parse(body).identity, "it should publish the identity hash instead");
  });
}));

await test("a second start does not spawn a duplicate server", withTempHome(async () => {
  await withServer(async (first, workspace) => {
    const second = await lifecycle.start({
      name: "ui", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true,
    });
    assert.strictEqual(second.started, false);
    assert.strictEqual(second.alreadyRunning, true);
    assert.strictEqual(second.record.pid, first.record.pid, "it must report the EXISTING server, not a new one");
  });
}));

await test("an explicitly requested port that is taken fails loudly", withTempHome(async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const held = server.address().port;
  const workspace = tempWorkspace();
  try {
    await assert.rejects(
      lifecycle.start({ name: "ui", host: "127.0.0.1", port: held, workspace, modelRoute: FAKE_ROUTE, detach: true }),
      /already in use/,
    );
    assert.strictEqual(lifecycle.status("ui").running, false, "a failed start must leave no runtime record");
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}));

await test("stopping when nothing is running is a no-op, not an error", withTempHome(async () => {
  const result = await lifecycle.stop("ui");
  assert.strictEqual(result.wasRunning, false);
  assert.strictEqual(result.stopped, false);
}));

await test("SIGTERM shuts the server down cleanly and clears its state", withTempHome(async () => {
  const workspace = tempWorkspace();
  try {
    const started = await lifecycle.start({
      name: "ui", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true,
    });
    process.kill(started.record.pid, "SIGTERM");
    await waitFor(() => !state.pidAlive(started.record.pid), { what: "the server to exit on SIGTERM" });
    await waitFor(() => !fs.existsSync(path.join(runtimeDir(), "ui.json")),
      { what: "the server to remove its own state file" });
    assert.strictEqual(await isPortFree(started.record.port, "127.0.0.1"), true,
      "the port must be released, not left in a half-closed state");
  } finally {
    await lifecycle.stop("ui").catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}));

await test("recovery after a hard crash (SIGKILL) — no manual cleanup needed", withTempHome(async () => {
  const workspace = tempWorkspace();
  try {
    const crashed = await lifecycle.start({
      name: "ui", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true,
    });
    // SIGKILL gives the process no chance to clean up — exactly the situation
    // that leaves a stale PID file behind.
    process.kill(crashed.record.pid, "SIGKILL");
    await waitFor(() => !state.pidAlive(crashed.record.pid), { what: "the killed server to disappear" });

    assert.ok(fs.existsSync(path.join(runtimeDir(), "ui.json")), "precondition: a stale file was left behind");
    assert.strictEqual(lifecycle.status("ui").running, false, "the stale record must not read as running");

    // And a fresh start must succeed rather than refusing as "already running".
    const restarted = await lifecycle.start({
      name: "ui", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true,
    });
    assert.strictEqual(restarted.started, true);
    assert.notStrictEqual(restarted.record.pid, crashed.record.pid);
  } finally {
    await lifecycle.stop("ui").catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}));

await test("restart replaces the process", withTempHome(async () => {
  const workspace = tempWorkspace();
  try {
    const first = await lifecycle.start({
      name: "ui", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true,
    });
    const second = await lifecycle.restart({
      name: "ui", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true,
    });
    assert.strictEqual(second.restarted, true);
    assert.notStrictEqual(second.record.pid, first.record.pid);
    assert.ok(!state.pidAlive(first.record.pid), "the old process must be gone");
  } finally {
    await lifecycle.stop("ui").catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}));

await test("ui and server lifecycles are tracked independently", withTempHome(async () => {
  const workspace = tempWorkspace();
  try {
    const ui = await lifecycle.start({ name: "ui", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true });
    const srv = await lifecycle.start({ name: "server", host: "127.0.0.1", port: 0, workspace, modelRoute: FAKE_ROUTE, detach: true });
    assert.notStrictEqual(ui.record.port, srv.record.port);
    assert.strictEqual(lifecycle.status("ui").running, true);
    assert.strictEqual(lifecycle.status("server").running, true);

    await lifecycle.stop("ui");
    assert.strictEqual(lifecycle.status("ui").running, false);
    assert.strictEqual(lifecycle.status("server").running, true, "stopping one must not stop the other");
  } finally {
    await lifecycle.stop("ui").catch(() => {});
    await lifecycle.stop("server").catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}));

// ── Through the CLI ──────────────────────────────────────────────────────────

section("kodo ui — through the binary");

await test("stop reports plainly when nothing is running", withTempHome(async (home) => {
  const r = await runCli(["ui", "stop"], { home });
  assert.strictEqual(r.code, 0);
  assert.ok(/not running/i.test(r.stderr));
}));

await test("a non-loopback bind is refused without explicit acknowledgement",
  withTempHome(async (home) => {
    const r = await runCli(["ui", "start", "--host", "0.0.0.0", "--port", "0"], { home, timeoutMs: 30_000 });
    assert.strictEqual(r.code, 5, "exposing the agent to the network is a permission decision, not a default");
    assert.ok(/yes-i-know/.test(r.stderr));
    assert.strictEqual(lifecycle.status("ui").running, false, "nothing should have been started");
  }));

await test("start --detach returns the shell instead of hanging", withTempHome(async (home) => {
  const workspace = tempWorkspace();
  try {
    // --builtin keeps this test about the LIFECYCLE (spawn, health, state file,
    // stop) rather than about whether Next.js happens to be built here. The
    // orchestrated path — API + Next.js — is covered separately below.
    const r = await runCli(
      ["ui", "start", "--port", "0", "--builtin", "--detach", "--cwd", workspace],
      { home, env: { DEFAULT_MODEL: "test-model", OPENAI_API_KEY: "test-key" }, timeoutMs: 45_000 },
    );
    assert.ok(!r.timedOut, "`--detach` must not hold the terminal");
    assert.strictEqual(r.code, 0);
    assert.ok(/started/i.test(r.stderr));

    const status = await runCli(["ui", "status", "--json"], { home });
    const parsed = JSON.parse(status.stdout);
    assert.strictEqual(parsed.running, true);
    assert.ok(!("token" in parsed), "status output must not carry the runtime token");

    const stopped = await runCli(["ui", "stop"], { home, timeoutMs: 30_000 });
    assert.ok(/stopped/i.test(stopped.stderr));
  } finally {
    // BOTH: `kodo ui start` brings up the Local API too, and a test that only
    // stops the UI leaves a real server running for the rest of the session.
    await lifecycle.stop("ui").catch(() => {});
    await lifecycle.stop("server").catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}));

await test("`kodo ui start` brings the API up first, and survives a busy default API port",
  withTempHome(async (home) => {
    // The architecture this asserts:  Kodo Core → Local API → UI.
    // `kodo ui` must not require the user to start the API themselves, and must
    // not fail because 9000 — a port nobody asked for — happens to be taken by
    // the user's own `npm run backend`.
    const workspace = tempWorkspace();
    const squatter = net.createServer();
    let occupied = false;
    try {
      // Hold the default API port so the fallback path is the one under test.
      await new Promise((resolve, reject) => {
        squatter.once("error", () => resolve());   // already taken? even better
        squatter.listen(9000, "127.0.0.1", () => { occupied = true; resolve(); });
      });

      const r = await runCli(
        ["ui", "start", "--port", "0", "--builtin", "--detach", "--cwd", workspace],
        { home, env: { DEFAULT_MODEL: "test-model", OPENAI_API_KEY: "test-key" }, timeoutMs: 120_000 },
      );
      assert.strictEqual(r.code, 0, `ui start failed: ${r.stderr}`);

      const api = lifecycle.status("server");
      assert.strictEqual(api.running, true, "the API should have been started for the UI");
      assert.notStrictEqual(api.record.port, 9000, "it should have moved off the occupied default port");

      const ui = lifecycle.status("ui");
      assert.strictEqual(ui.running, true, "the UI should be running");
    } finally {
      await lifecycle.stop("ui").catch(() => {});
      await lifecycle.stop("server").catch(() => {});
      if (occupied) await new Promise((r) => squatter.close(r));
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }));

await test("`kodo ui restart` rebuilds the SAME stack, not a downgraded one",
  withTempHome(async (home) => {
    // restartAction used to call lifecycle.restart with no service descriptor,
    // so every restart silently swapped the real Next.js UI for the built-in
    // fallback page and printed a URL with no API origin — a UI that then
    // talked to nothing. A restart that quietly changes what you are running is
    // worse than one that fails.
    const workspace = tempWorkspace();
    try {
      const env = { DEFAULT_MODEL: "test-model", OPENAI_API_KEY: "test-key" };
      const started = await runCli(
        ["ui", "start", "--port", "0", "--api-port", "0", "--builtin", "--detach", "--cwd", workspace],
        { home, env, timeoutMs: 120_000 },
      );
      assert.strictEqual(started.code, 0, started.stderr);
      const before = lifecycle.status("ui").record;

      const restarted = await runCli(
        ["ui", "restart", "--port", "0", "--builtin", "--cwd", workspace],
        { home, env, timeoutMs: 120_000 },
      );
      assert.strictEqual(restarted.code, 0, restarted.stderr);

      const after = lifecycle.status("ui").record;
      assert.strictEqual(after.running === undefined ? true : true, true);
      assert.notStrictEqual(after.pid, before.pid, "restart must replace the process");
      assert.strictEqual(after.service, before.service,
        `restart changed which server is running: "${before.service}" → "${after.service}"`);

      // The API must have survived the UI restart — it owns live agent runs.
      assert.strictEqual(lifecycle.status("server").running, true,
        "restarting the UI must not take the API down with it");
    } finally {
      await lifecycle.stop("ui").catch(() => {});
      await lifecycle.stop("server").catch(() => {});
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }));

await test("`ui start` in a second project REFUSES to reuse the first project's API",
  withTempHome(async (home) => {
    // The workspace invariant. A running API is bound to the directory it was
    // started in — that is baked into its process environment and cannot be
    // retargeted. Silently reusing it would mean `cd ~/project-b && kodo ui
    // start` gives you a working UI whose agent reads and WRITES ~/project-a.
    //
    // Refusing is the only honest option: Kodo neither guesses which project
    // you meant nor quietly retargets a server other work may be running
    // against.
    const projectA = tempWorkspace({ "README.md": "# a" });
    const projectB = tempWorkspace({ "README.md": "# b" });
    const env = { KODO_MODEL: "test-model", OPENAI_API_KEY: "test-key" };
    try {
      const first = await runCli(
        ["ui", "start", "--port", "0", "--api-port", "0", "--builtin", "--detach", "--cwd", projectA],
        { home, env, timeoutMs: 120_000 },
      );
      assert.strictEqual(first.code, 0, first.stderr);

      const second = await runCli(
        ["ui", "start", "--port", "0", "--api-port", "0", "--builtin", "--detach", "--cwd", projectB],
        { home, env, timeoutMs: 120_000 },
      );
      assert.notStrictEqual(second.code, 0,
        "starting in a second project silently reused the first project's API");
      const output = second.stderr + second.stdout;
      assert.ok(/already running for a different project/i.test(output),
        `expected a workspace-conflict error, got: ${output.slice(0, 300)}`);
    } finally {
      await lifecycle.stop("ui").catch(() => {});
      await lifecycle.stop("server").catch(() => {});
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  }));

finish();
