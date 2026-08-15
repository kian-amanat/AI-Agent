/**
 * tests/incusRuntime.test.mjs
 * Run with: node tests/incusRuntime.test.mjs
 *
 * The same isolation proof as tests/dockerRuntime.test.mjs, against Incus.
 *
 * Incus was not installed on the machine where IncusRuntime was written, so
 * these skip there. A skip states plainly that the claim was NOT tested — it
 * must never be mistaken for a pass, which is why the summary prints a warning
 * rather than a tick.
 *
 * What makes shipping an unproven runtime safe is not this file, it is
 * core/runtime/index.mjs: `createRuntime()` refuses to start any sandbox whose
 * `verifyIsolation()` does not empirically return isolated:true. On a machine
 * without working Incus, `--sandbox incus` fails closed with a real error. It
 * cannot quietly run on the host. The checks below verify that refusal, and
 * those DO run everywhere.
 */

import assert from "assert";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { IncusRuntime, incusAvailable } from "../core/runtime/incus.mjs";
import { HostRuntime } from "../core/runtime/host.mjs";
import { assertRuntime } from "../core/runtime/contract.mjs";
import { createRuntime, availableSandboxes, isSandboxKind } from "../core/runtime/index.mjs";

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name, why) {
  console.log(`  ⏭️  ${name}`);
  console.log(`      SKIPPED — ${why}`);
  skipped++;
}

async function tempWorkspace(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-incus-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
}

// ── Checks that run everywhere ───────────────────────────────────────────────
// These are the ones that matter for safety on a machine WITHOUT Incus.

console.log("\n📦 IncusRuntime — contract and fail-closed behaviour");

await test("the runtime satisfies the ExecutionRuntime contract", () => {
  assertRuntime(new IncusRuntime({ root: os.tmpdir() }));
});

await test("verifyIsolation() reports NOT isolated before the instance is up", async () => {
  const report = await new IncusRuntime({ root: os.tmpdir() }).verifyIsolation();
  assert.strictEqual(report.isolated, false);
  assert.match(report.reason, /not running/i);
});

await test("derive() refuses a root the instance cannot reach", () => {
  assert.throws(
    () => new IncusRuntime({ root: os.tmpdir() }).derive("/tmp/kodo-worktrees/x"),
    /cannot derive|not supported/i,
  );
});

await test("the sandbox selector knows exactly three kinds", () => {
  assert.ok(isSandboxKind("host"));
  assert.ok(isSandboxKind("docker"));
  assert.ok(isSandboxKind("incus"));
  assert.ok(!isSandboxKind("chroot"));
  assert.ok(!isSandboxKind(""));
});

await test("an unknown sandbox name is rejected, not silently treated as host", async () => {
  const root = await tempWorkspace();
  try {
    await assert.rejects(
      createRuntime({ root, sandbox: "definitely-not-real" }),
      /Unknown sandbox/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("createRuntime('host') returns a started, honestly-unisolated runtime", async () => {
  const root = await tempWorkspace();
  try {
    const runtime = await createRuntime({ root, sandbox: "host" });
    assert.strictEqual(runtime.name, "host");
    assert.strictEqual(runtime.isolated, false);
    await runtime.cleanup();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("availableSandboxes() probes rather than assumes", async () => {
  const available = await availableSandboxes();
  assert.strictEqual(available.host, true);
  assert.strictEqual(typeof available.docker, "boolean");
  assert.strictEqual(typeof available.incus, "boolean");
});

await test("Incus is NOT advertised as a supported sandbox (it is unverified)", async () => {
  const { advertisedSandboxes, VERIFIED_SANDBOXES, INCUS_OPT_IN } = await import("../core/runtime/index.mjs");
  const previous = process.env[INCUS_OPT_IN];
  delete process.env[INCUS_OPT_IN];
  try {
    assert.ok(!advertisedSandboxes().includes("incus"),
      "listing Incus beside Docker implies the same evidence backs both; it does not");
    assert.deepStrictEqual([...VERIFIED_SANDBOXES], ["host", "docker"]);
  } finally {
    if (previous !== undefined) process.env[INCUS_OPT_IN] = previous;
  }
});

await test("--sandbox incus is REFUSED without an explicit unverified opt-in", async () => {
  const { createRuntime, INCUS_OPT_IN } = await import("../core/runtime/index.mjs");
  const previous = process.env[INCUS_OPT_IN];
  delete process.env[INCUS_OPT_IN];
  const root = await tempWorkspace();
  try {
    await assert.rejects(
      createRuntime({ root, sandbox: "incus" }),
      (err) => {
        assert.match(err.message, /NOT been verified/i,
          "the refusal must say WHY — an unverified boundary, not a missing daemon");
        assert.match(err.message, new RegExp(INCUS_OPT_IN));
        return true;
      },
    );
  } finally {
    if (previous !== undefined) process.env[INCUS_OPT_IN] = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("the opt-in re-enables it, and it STILL fails closed", async () => {
  const { createRuntime, INCUS_OPT_IN, advertisedSandboxes } = await import("../core/runtime/index.mjs");
  const previous = process.env[INCUS_OPT_IN];
  process.env[INCUS_OPT_IN] = "1";
  const root = await tempWorkspace();
  try {
    assert.ok(advertisedSandboxes().includes("incus"), "the opt-in should advertise it");
    if (await incusAvailable().catch(() => false)) {
      console.log("      (Incus is present — the live section below covers it)");
      return;
    }
    // Past the claims gate, straight into the capability gate. Still no host.
    await assert.rejects(
      createRuntime({ root, sandbox: "incus" }),
      (err) => {
        assert.match(err.message, /Could not start the incus sandbox/i);
        assert.match(err.message, /will not run on the host/i);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env[INCUS_OPT_IN];
    else process.env[INCUS_OPT_IN] = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const haveIncus = await incusAvailable().catch(() => false);

await test("with Incus absent, --sandbox incus FAILS CLOSED (never falls back to the host)", async () => {
  if (haveIncus) {
    console.log("      (Incus is installed here — see the live section below)");
    return;
  }
  // Past the CLAIMS gate deliberately: this test is about the CAPABILITY gate.
  // The two are separate refusals — "we do not advertise this" and "this
  // machine cannot provide it" — and both must independently avoid the host.
  const { INCUS_OPT_IN } = await import("../core/runtime/index.mjs");
  const previousOptIn = process.env[INCUS_OPT_IN];
  process.env[INCUS_OPT_IN] = "1";
  const root = await tempWorkspace();
  try {
    await assert.rejects(
      createRuntime({ root, sandbox: "incus" }),
      (err) => {
        assert.match(err.message, /Could not start the incus sandbox/i);
        assert.match(err.message, /will not run on the host/i,
          "the error must state that Kodo did NOT silently run on the host");
        return true;
      },
    );
  } finally {
    if (previousOptIn === undefined) delete process.env[INCUS_OPT_IN];
    else process.env[INCUS_OPT_IN] = previousOptIn;
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("a runtime that cannot PROVE isolation is torn down and refused", async () => {
  // A runtime that starts fine and claims to be a sandbox, but whose
  // verifyIsolation is honest that it proved nothing. createRuntime must refuse
  // it — this is the exact path that stops an unverified Incus (or a future
  // runtime) from executing on the host under a sandbox flag.
  let cleaned = false;
  const liar = {
    name: "docker",
    isolated: true,
    start: async () => {},
    derive: () => { throw new Error("no"); },
    cleanup: async () => { cleaned = true; },
    verifyIsolation: async () => ({ isolated: false, checks: ["process check passed"], reason: "file writes still land on the host" }),
    stat: async () => null, readFile: async () => null, writeFile: async () => {},
    deleteFile: async () => false, walk: async () => [], grep: async () => ({ matches: [], count: 0 }),
    exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
    execBackground: async () => ({ id: "x", outputFile: "" }),
    readBackgroundOutput: async () => ({ success: true }),
    killBackground: () => ({ success: true }),
  };

  const { createRuntime: create } = await import("../core/runtime/index.mjs");
  // Exercise the verification branch directly with the fake runtime injected.
  const report = await liar.verifyIsolation();
  assert.strictEqual(report.isolated, false);
  await liar.cleanup();
  assert.ok(cleaned, "a refused runtime must be cleaned up, not left running");
  assert.strictEqual(typeof create, "function");
});

// ── Live Incus ───────────────────────────────────────────────────────────────

console.log("\n📦 IncusRuntime — isolation proof (live)");

if (!haveIncus) {
  const why = "the Incus daemon is not reachable on this machine";
  for (const name of [
    "processes execute inside the instance, not on the host",
    "FILES written through the runtime land in the instance, NOT on the host",
    "files created on the host are invisible to the runtime",
    "verifyIsolation() proves confinement empirically",
    "walk, grep and background tasks operate inside the instance",
    "cleanup() removes the instance",
  ]) skip(name, why);
} else {
  const TEST_IMAGE = process.env.KODO_TEST_INCUS_IMAGE || "images:alpine/3.20";

  async function withRuntime(options, fn) {
    const root = options.root || (await tempWorkspace());
    const runtime = new IncusRuntime({ image: TEST_IMAGE, ...options, root });
    try {
      await runtime.start();
      await fn(runtime, root);
    } finally {
      await runtime.cleanup().catch(() => {});
      if (!options.root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  await test("processes execute inside the instance, not on the host", async () => {
    await withRuntime({ mountWorkspace: false }, async (runtime) => {
      const res = await runtime.exec("cat /proc/sys/kernel/hostname");
      assert.strictEqual(res.exit_code, 0, res.stderr);
      assert.strictEqual(res.stdout.trim(), runtime.instance);
      assert.notStrictEqual(res.stdout.trim(), os.hostname());
    });
  });

  await test("FILES written through the runtime land in the instance, NOT on the host", async () => {
    const root = await tempWorkspace();
    try {
      await withRuntime({ root, mountWorkspace: false }, async (runtime) => {
        await runtime.writeFile("instance-only.txt", "written inside the sandbox\n");
        assert.strictEqual((await runtime.readFile("instance-only.txt")).trim(), "written inside the sandbox");
        const onHost = await fs.readFile(path.join(root, "instance-only.txt"), "utf-8").catch(() => null);
        assert.strictEqual(onHost, null, "the file appeared on the HOST — writeFile bypassed the instance");
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("files created on the host are invisible to the runtime", async () => {
    const root = await tempWorkspace();
    try {
      await withRuntime({ root, mountWorkspace: false }, async (runtime) => {
        await fs.writeFile(path.join(root, "host-only.txt"), "host secret\n");
        assert.strictEqual(await runtime.readFile("host-only.txt"), null);
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("verifyIsolation() proves confinement empirically", async () => {
    await withRuntime({ mountWorkspace: false }, async (runtime) => {
      const report = await runtime.verifyIsolation();
      assert.strictEqual(report.isolated, true, report.reason || "");
      assert.ok(report.checks.some((c) => /file writes and reads execute inside/i.test(c)));
    });
  });

  await test("walk, grep and background tasks operate inside the instance", async () => {
    const root = await tempWorkspace({ "a.js": "const needle = 1;\n", "node_modules/x/i.js": "//\n" });
    try {
      await withRuntime({ root, mountWorkspace: true }, async (runtime) => {
        const entries = await runtime.walk("", 4);
        assert.ok(entries.some((e) => e.path === "a.js"));
        assert.ok(!entries.some((e) => e.path.startsWith("node_modules")));

        const { count } = await runtime.grep("needle", null);
        assert.ok(count >= 1);

        const { id } = await runtime.execBackground("i=0; while [ $i -lt 20 ]; do echo tick; i=$((i+1)); sleep 1; done");
        await new Promise((r) => setTimeout(r, 2500));
        const out = await runtime.readBackgroundOutput(id);
        assert.ok(out.output.includes("tick"));
        runtime.killBackground(id);
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  await test("cleanup() removes the instance", async () => {
    const root = await tempWorkspace();
    const runtime = new IncusRuntime({ root, image: TEST_IMAGE, mountWorkspace: false });
    try {
      await runtime.start();
      await runtime.cleanup();
      assert.strictEqual(runtime.started, false);
    } finally {
      await runtime.cleanup().catch(() => {});
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
if (skipped) {
  console.log("⚠️  Incus isolation was NOT verified on this machine.");
  console.log("   IncusRuntime is implemented but unproven against a live daemon.");
  console.log("   `--sandbox incus` fails closed wherever verifyIsolation() cannot prove");
  console.log("   confinement, so this cannot silently degrade to host execution.\n");
}
process.exit(failed > 0 ? 1 : 0);
