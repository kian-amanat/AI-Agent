/**
 * tests/sandbox.test.mjs
 * Run with: node tests/sandbox.test.mjs
 *
 * The `--sandbox` flag's contract at the CLI boundary.
 *
 * The isolation itself is proven in backend1/tests/dockerRuntime.test.mjs —
 * that is where files get written inside a container and looked for on the
 * host. What is checked HERE is the promise the flag makes to the user:
 *
 *   - a bad value is rejected rather than quietly meaning "host";
 *   - an unavailable sandbox FAILS the command rather than running unsandboxed;
 *   - the error says, in words, that Kodo did not run on the host instead.
 *
 * That last one matters as much as the mechanism. A user who asked for
 * confinement and silently did not get it is worse off than one who got an
 * error, because they will point an autonomous agent at their machine believing
 * it is contained.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { assert, test, section, finish, runCli, withTempHome, tempWorkspace } from "./harness.mjs";
import { SANDBOX_KINDS } from "../src/sandbox.mjs";
import { EXIT } from "../src/exit.mjs";

const execFileAsync = promisify(execFile);

async function dockerUsable() {
  try {
    await execFileAsync("docker", ["info"], { timeout: 8000 });
    await execFileAsync("docker", ["image", "inspect", "alpine:3.20"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Config that gets past the credential checks without reaching a provider. */
function fakeCredentials(home) {
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ model: "test-model", apiKey: "sk-not-a-real-key", baseUrl: "http://127.0.0.1:1" }),
  );
}

section("--sandbox — the flag's contract");

await test("three kinds exist, but only VERIFIED ones are advertised", async () => {
  const { VERIFIED_SANDBOX_KINDS, advertisedKinds } = await import("../src/sandbox.mjs");
  assert.deepStrictEqual(SANDBOX_KINDS, ["host", "docker", "incus"],
    "all three are implemented");
  assert.deepStrictEqual(VERIFIED_SANDBOX_KINDS, ["host", "docker"],
    "only these have isolation proven against live infrastructure");

  const previous = process.env.KODO_ENABLE_UNVERIFIED_INCUS;
  delete process.env.KODO_ENABLE_UNVERIFIED_INCUS;
  try {
    assert.ok(!advertisedKinds().includes("incus"),
      "advertising Incus beside Docker would imply evidence that does not exist");
  } finally {
    if (previous !== undefined) process.env.KODO_ENABLE_UNVERIFIED_INCUS = previous;
  }
});

await test("an unknown sandbox is a usage error, never a silent 'host'", withTempHome(async (home) => {
  fakeCredentials(home);
  const ws = tempWorkspace({ "a.txt": "x" });
  try {
    const r = await runCli(["run", "do a thing", "--cwd", ws, "--sandbox", "chroot"], { home, timeoutMs: 60_000 });
    assert.strictEqual(r.code, EXIT.USAGE);
    assert.match(r.stderr, /Unknown sandbox/);
    // Only the ADVERTISED kinds are suggested — Incus is implemented but
    // unverified, so pointing a confused user at it would be a bad suggestion.
    assert.match(r.stderr, /host, docker/);
    assert.ok(!/host, docker, incus/.test(r.stderr),
      "an unverified sandbox must not be suggested as a valid value");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}));

await test("an unavailable sandbox FAILS the run and says it did not use the host",
  withTempHome(async (home) => {
    fakeCredentials(home);
    const ws = tempWorkspace({ "a.txt": "x" });
    try {
      // TWO independent refusals stand between a user and an unverified
      // sandbox, and both must avoid the host.
      //
      // 1. The CLAIMS gate: Incus is unverified, so it is refused outright.
      const claims = await runCli(["run", "do a thing", "--cwd", ws, "--sandbox", "incus"], { home, timeoutMs: 90_000 });
      assert.strictEqual(claims.code, EXIT.PERMISSION);
      assert.match(claims.stderr, /NOT been verified/i,
        "the refusal must name the real reason: unverified, not unavailable");

      // 2. The CAPABILITY gate: past the opt-in, an absent daemon still refuses.
      const r = await runCli(["run", "do a thing", "--cwd", ws, "--sandbox", "incus"], {
        home,
        env: { KODO_ENABLE_UNVERIFIED_INCUS: "1" },
        timeoutMs: 90_000,
      });
      assert.strictEqual(r.code, EXIT.PERMISSION,
        "a sandbox that cannot be provided must fail the command, not downgrade it");
      assert.match(r.stderr, /will not run on the host/i,
        "the error must state plainly that Kodo did NOT silently fall back to the host");
      assert.strictEqual(r.stdout.trim(), "",
        "nothing should have been produced — the agent never ran");

      // And the workspace is untouched.
      const entries = fs.readdirSync(ws);
      assert.deepStrictEqual(entries, ["a.txt"], "the agent must not have touched the workspace");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }));

await test("`--sandbox host` is accepted and explicitly unconfined", withTempHome(async (home) => {
  const { openSandbox } = await import("../src/sandbox.mjs");
  const opened = await openSandbox({ core: null, sandbox: "host", workspace: os.tmpdir(), quiet: true });
  assert.strictEqual(opened.runtime, null, "host means no runtime override, i.e. the default");
  await opened.dispose();
}));

section("--sandbox docker — live");

if (!(await dockerUsable())) {
  console.log("  ⏭️  a docker sandbox starts, is verified, and is cleaned up");
  console.log("      SKIPPED — Docker or the alpine:3.20 test image is unavailable here");
  console.log("      (isolation itself is proven in backend1/tests/dockerRuntime.test.mjs)");
} else {
  await test("a docker sandbox starts, is verified, and is cleaned up", withTempHome(async (home) => {
    const { openSandbox } = await import("../src/sandbox.mjs");
    const core = await (await import("../src/core.mjs")).loadCore();
    const ws = tempWorkspace({ "a.txt": "x" });
    let opened = null;
    try {
      opened = await openSandbox({
        core,
        sandbox: "docker",
        workspace: ws,
        quiet: true,
      });
      assert.ok(opened.runtime, "a runtime should have been returned");
      assert.strictEqual(opened.runtime.name, "docker");
      assert.strictEqual(opened.runtime.isolated, true);

      // It was verified before being handed over — re-verifying must still pass.
      const report = await opened.runtime.verifyIsolation();
      assert.strictEqual(report.isolated, true, report.reason || "");

      const containerId = opened.runtime.containerId;
      await opened.dispose();
      opened = null;

      const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", `id=${containerId}`, "--format", "{{.ID}}"]);
      assert.strictEqual(stdout.trim(), "", "dispose() must remove the container — a leaked one holds the user's source");
    } finally {
      if (opened) await opened.dispose().catch(() => {});
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }));
}

finish();
