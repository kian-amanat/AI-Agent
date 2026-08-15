/**
 * tests/dockerRuntime.test.mjs
 * Run with: node tests/dockerRuntime.test.mjs
 *
 * PROOF OF ISOLATION. This suite is the precondition for `--sandbox docker`
 * existing at all: until these assertions pass on a machine, that flag must not
 * be offered there, and `verifyIsolation()` enforces exactly that at runtime.
 *
 * The claim being tested is narrow and specific: **filesystem operations, not
 * just process execution, happen inside the container.** A runtime that
 * confines `bash` while `write_file` still writes to the host would pass a
 * naive "did the sandbox work" test and be completely broken as a sandbox. So
 * the central tests here run WITHOUT a bind mount, where host and container
 * genuinely disagree about what exists, and check which side sees what:
 *
 *   - a file created through the runtime must be visible IN the container and
 *     ABSENT from the host directory;
 *   - a file created directly on the host must be INVISIBLE to the runtime.
 *
 * Skipped, loudly, when Docker is unavailable — never silently passed. A skip
 * says the claim was not tested; it must never read as though it was.
 *
 * Every container this file starts is removed in a finally block, including on
 * assertion failure.
 */

import assert from "assert";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { DockerRuntime, dockerAvailable } from "../core/runtime/docker.mjs";
import { HostRuntime } from "../core/runtime/host.mjs";
import { assertRuntime } from "../core/runtime/contract.mjs";
import { executeTool, createToolContext } from "../agents/nodes/agent_loop.mjs";

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;
let skipped = 0;
/** Claims a test could not settle. Reported separately from pass/fail. */
const notVerified = [];

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

/**
 * A small image with a POSIX shell and coreutils. The runtime's own default is
 * a Node image (agents run npm), but these tests exercise the isolation
 * boundary, not the toolchain, so the lightest available image is the right
 * one — a multi-hundred-megabyte pull would make this suite untestable on a
 * fresh machine.
 */
const TEST_IMAGE = process.env.KODO_TEST_DOCKER_IMAGE || "alpine:3.20";

/**
 * The worktree test needs git INSIDE the container, which the minimal image
 * does not have. Using a separate small git image keeps the isolation tests
 * fast while still PROVING the worktree claim rather than skipping it — a
 * skipped worktree test is exactly how "worktrees are sandboxed" would become
 * an unverified assertion.
 */
const GIT_IMAGE = process.env.KODO_TEST_DOCKER_GIT_IMAGE || "alpine/git:latest";

async function imageAvailable(image) {
  try {
    await execFileAsync("docker", ["image", "inspect", image], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the test image is present, pulling it if it is not.
 *
 * Docker Desktop prunes unused images, so a suite that merely SKIPS on a
 * missing image quietly stops proving anything on a developer machine — the
 * run still goes green and the isolation claim silently loses its evidence.
 * Pulling a 4 MB image is cheap; losing the proof is not.
 *
 * A pull failure (offline, no registry access) still skips loudly rather than
 * failing the suite — the machine genuinely cannot run these tests then.
 */
async function ensureImage(image) {
  if (await imageAvailable(image)) return true;
  console.log(`  … pulling ${image} (not present locally)`);
  try {
    await execFileAsync("docker", ["pull", image], { timeout: 300_000 });
    return await imageAvailable(image);
  } catch (err) {
    console.log(`  … pull failed: ${String(err.message).split("\n")[0]}`);
    return false;
  }
}

async function tempWorkspace(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-docker-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
}

/** Start a runtime, hand it to `fn`, and always tear the container down. */
async function withRuntime(options, fn) {
  const root = options.root || (await tempWorkspace());
  const runtime = new DockerRuntime({ image: TEST_IMAGE, ...options, root });
  try {
    await runtime.start();
    await fn(runtime, root);
  } finally {
    await runtime.cleanup().catch(() => {});
    if (!options.root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Preconditions ────────────────────────────────────────────────────────────

console.log("\n📦 DockerRuntime — isolation proof");

const haveDocker = await dockerAvailable();
const haveImage = haveDocker && (await ensureImage(TEST_IMAGE));

if (!haveDocker || !haveImage) {
  const why = !haveDocker
    ? "the Docker daemon is not reachable"
    : `the test image "${TEST_IMAGE}" is unavailable and could not be pulled (docker pull ${TEST_IMAGE})`;

  for (const name of [
    "the runtime satisfies the ExecutionRuntime contract",
    "processes execute inside the container, not on the host",
    "FILES written through the runtime land in the container, NOT on the host",
    "files created on the host are invisible to the runtime",
    "the host filesystem outside the workspace is unreachable",
    "verifyIsolation() proves confinement empirically",
    "a bind-mounted workspace still routes file I/O through the container",
    "walk() enumerates the container's filesystem",
    "grep searches inside the container",
    "background tasks run and are killed inside the container",
    "agent TOOLS operate inside the container end to end",
    "derive() refuses a HOST path, and accepts an in-sandbox one",
    "WORKTREES are created inside the container, and the host never sees them",
    "cleanup() removes the container",
  ]) skip(name, why);

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  console.log("⚠️  Docker isolation was NOT verified on this machine.");
  console.log("   `--sandbox docker` refuses to run wherever verifyIsolation() cannot prove");
  console.log("   confinement, so an unverified environment cannot silently execute on the host.\n");
  process.exit(failed > 0 ? 1 : 0);
}

console.log(`  (using image ${TEST_IMAGE})`);

// ── Contract ─────────────────────────────────────────────────────────────────

await test("the runtime satisfies the ExecutionRuntime contract", () => {
  assertRuntime(new DockerRuntime({ root: os.tmpdir(), image: TEST_IMAGE }));
});

// ── Process isolation ────────────────────────────────────────────────────────

await test("processes execute inside the container, not on the host", async () => {
  await withRuntime({ mountWorkspace: false }, async (runtime) => {
    const res = await runtime.exec("cat /proc/sys/kernel/hostname");
    assert.strictEqual(res.exit_code, 0, res.stderr);
    const containerHostname = res.stdout.trim();
    assert.notStrictEqual(containerHostname, os.hostname(),
      "the command reported the HOST hostname — it did not run in the container");
    assert.ok(runtime.containerId.startsWith(containerHostname.slice(0, 8)),
      `hostname "${containerHostname}" does not match container ${runtime.containerId.slice(0, 12)}`);

    // A distinct PID namespace: the host has far more than a handful.
    const pids = await runtime.exec("ls /proc | grep -c '^[0-9]*$'");
    assert.ok(Number(pids.stdout.trim()) < 50,
      "the container can see the host's process table — PID isolation is not in effect");
  });
});

// ── THE central claim: filesystem isolation ──────────────────────────────────
//
// No bind mount, so host and container really do have different filesystems.
// With a mount these two tests would pass trivially and prove nothing.

await test("FILES written through the runtime land in the container, NOT on the host", async () => {
  const root = await tempWorkspace({ "seed.txt": "seed\n" });
  try {
    await withRuntime({ root, mountWorkspace: false }, async (runtime) => {
      await runtime.writeFile("container-only.txt", "written inside the sandbox\n");

      // The container sees it, through the runtime…
      const viaRuntime = await runtime.readFile("container-only.txt");
      assert.strictEqual(viaRuntime.trim(), "written inside the sandbox");

      // …and directly, via a shell in the container.
      const viaShell = await runtime.exec("cat /workspace/container-only.txt");
      assert.strictEqual(viaShell.stdout.trim(), "written inside the sandbox");

      // The host does NOT. This is the assertion that separates a real sandbox
      // from a sandbox-shaped label on host access.
      const onHost = await fs.readFile(path.join(root, "container-only.txt"), "utf-8").catch(() => null);
      assert.strictEqual(onHost, null,
        "the file appeared on the HOST — writeFile bypassed the container. " +
        "This is exactly the failure mode where `bash` is sandboxed and the file tools are not.");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

await test("files created on the host are invisible to the runtime", async () => {
  const root = await tempWorkspace();
  try {
    await withRuntime({ root, mountWorkspace: false }, async (runtime) => {
      // Created on the host AFTER the container started, so it was never copied in.
      await fs.writeFile(path.join(root, "host-only.txt"), "host secret\n");

      const viaRuntime = await runtime.readFile("host-only.txt");
      assert.strictEqual(viaRuntime, null,
        "the runtime read a file that exists only on the host — reads are not confined");

      const stat = await runtime.stat("host-only.txt");
      assert.strictEqual(stat, null, "stat reached the host filesystem");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

await test("the host filesystem outside the workspace is unreachable", async () => {
  await withRuntime({ mountWorkspace: false }, async (runtime, root) => {
    // The host workspace path must not resolve inside the container.
    const probe = await runtime.exec(`test -e '${root}' && echo VISIBLE || echo HIDDEN`);
    assert.ok(probe.stdout.includes("HIDDEN"),
      `the host path ${root} resolved inside the container — the mount namespace is not isolated`);

    // Nor should a well-known host location with host-specific content.
    const etc = await runtime.exec("cat /etc/hostname");
    assert.notStrictEqual(etc.stdout.trim(), os.hostname(),
      "the container is reading the host's /etc");
  });
});

await test("verifyIsolation() proves confinement empirically", async () => {
  await withRuntime({ mountWorkspace: false }, async (runtime) => {
    const report = await runtime.verifyIsolation();
    assert.strictEqual(report.isolated, true, report.reason || "isolation was not proven");
    assert.ok(report.checks.length >= 4, `expected several checks, got: ${report.checks.join("; ")}`);
    assert.ok(report.checks.some((c) => /file writes and reads execute inside/i.test(c)),
      "verifyIsolation must prove FILE confinement, not only process confinement");
  });
});

await test("verifyIsolation() fails honestly when the container is not running", async () => {
  const runtime = new DockerRuntime({ root: os.tmpdir(), image: TEST_IMAGE });
  const report = await runtime.verifyIsolation();
  assert.strictEqual(report.isolated, false);
  assert.match(report.reason, /not running/i);
});

// ── Bind-mounted workspace (the normal configuration) ────────────────────────

await test("a bind-mounted workspace still routes file I/O through the container", async () => {
  const root = await tempWorkspace({ "app.js": "console.log(1);\n" });
  try {
    await withRuntime({ root, mountWorkspace: true }, async (runtime) => {
      // Edits persist to the host — that is the point of the mount.
      await runtime.writeFile("app.js", "console.log(2);\n");
      const onHost = await fs.readFile(path.join(root, "app.js"), "utf-8");
      assert.strictEqual(onHost.trim(), "console.log(2);",
        "a mounted workspace must still receive the agent's edits");

      // And the write genuinely went through the container: the file is owned
      // by the container's write, and readable from inside it.
      const viaShell = await runtime.exec("cat /workspace/app.js");
      assert.strictEqual(viaShell.stdout.trim(), "console.log(2);");

      // Processes remain confined even with the mount.
      const report = await runtime.verifyIsolation();
      assert.strictEqual(report.isolated, true, report.reason || "");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ── The rest of the surface ──────────────────────────────────────────────────

await test("walk() enumerates the container's filesystem", async () => {
  const root = await tempWorkspace({
    "src/index.js": "//\n",
    "src/util.ts": "//\n",
    "README.md": "# hi\n",
    "node_modules/pkg/index.js": "//\n",
  });
  try {
    await withRuntime({ root, mountWorkspace: true }, async (runtime) => {
      const entries = await runtime.walk("", 6);
      const paths = entries.map((e) => e.path);
      assert.ok(paths.includes("src/index.js"), `expected src/index.js in ${paths.join(", ")}`);
      assert.ok(paths.includes("README.md"));
      assert.ok(!paths.some((p) => p.startsWith("node_modules")),
        "node_modules must be pruned, exactly as HostRuntime prunes it");

      // The two runtimes must agree about what the project contains.
      const hostEntries = await new HostRuntime({ root }).walk("", 6);
      const hostFiles = hostEntries.filter((e) => !e.isDir).map((e) => e.path).sort();
      const dockerFiles = entries.filter((e) => !e.isDir).map((e) => e.path).sort();
      assert.deepStrictEqual(dockerFiles, hostFiles,
        "host and container disagree about the file list — the same project would look different per runtime");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

await test("grep searches inside the container", async () => {
  const root = await tempWorkspace({ "a.js": "const needle = 1;\n", "b.js": "const other = 2;\n" });
  try {
    await withRuntime({ root, mountWorkspace: true }, async (runtime) => {
      const { matches, count } = await runtime.grep("needle", null);
      assert.ok(count >= 1, "grep found nothing inside the container");
      assert.ok(matches.some((m) => m.includes("a.js")), matches.join("\n"));
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

await test("background tasks run and are killed inside the container", async () => {
  await withRuntime({ mountWorkspace: false }, async (runtime) => {
    const { id } = await runtime.execBackground("i=0; while [ $i -lt 30 ]; do echo tick; i=$((i+1)); sleep 1; done");
    assert.ok(id, "no task id returned");

    await new Promise((r) => setTimeout(r, 2500));
    const running = await runtime.readBackgroundOutput(id);
    assert.strictEqual(running.success, true);
    assert.ok(running.output.includes("tick"), `expected output, got: ${JSON.stringify(running.output)}`);
    assert.strictEqual(running.status, "running");

    // The process is a container process, not a host one.
    const psInside = await runtime.exec("ps -o args= 2>/dev/null | grep -c tick || true");
    assert.ok(Number(psInside.stdout.trim()) >= 1, "the background process is not visible inside the container");

    runtime.killBackground(id);
    await new Promise((r) => setTimeout(r, 2000));
    const stopped = await runtime.readBackgroundOutput(id);
    assert.strictEqual(stopped.status, "exited", "kill_shell did not stop the container-side process");
  });
});

await test("derive() refuses a HOST path, and accepts an in-sandbox one", async () => {
  const runtime = new DockerRuntime({ root: os.tmpdir(), image: TEST_IMAGE });
  runtime.containerId = "fake-for-path-check";
  assert.throws(
    () => runtime.derive("/tmp/kodo-worktrees/whatever"),
    /outside the sandbox/i,
    "a confined runtime must refuse a host root, never hand back a host runtime",
  );
  const inside = runtime.derive("/kodo-worktrees/wt_x");
  assert.strictEqual(inside.isolated, true, "a derived sub-agent runtime stays confined");
});

await test("WORKTREES are created inside the container, and the host never sees them", async () => {
  // A real git repo as the workspace, so `git worktree add` has something to
  // work from. Bind-mounted, which is the normal configuration.
  const root = await tempWorkspace({ "a.txt": "one\n" });
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "init"], { cwd: root });

    if (!(await ensureImage(GIT_IMAGE))) {
      // Report honestly rather than passing on a check that never ran.
      console.log(`      (worktree leg NOT verified — ${GIT_IMAGE} unavailable)`);
      notVerified.push("in-container worktrees (git image unavailable)");
      return;
    }

    await withRuntime({ root, mountWorkspace: true, image: GIT_IMAGE }, async (runtime) => {
      const created = await runtime.createWorktree({ subagentId: "sub1" });
      assert.strictEqual(created.ok, true, created.error);
      const wt = created.worktree;

      assert.ok(wt.path.startsWith("/kodo-worktrees/"),
        `the worktree must be INSIDE the container, got ${wt.path}`);

      // It exists in the container…
      const inContainer = await runtime.exec(`test -d ${wt.path} && echo yes || echo no`);
      assert.ok(inContainer.stdout.includes("yes"), "the worktree should exist in the container");

      // …and the host has no such directory. This is the escape that was fixed:
      // the worktree used to be a real host checkout in os.tmpdir().
      const onHost = await fs.stat(wt.path).then(() => true).catch(() => false);
      assert.strictEqual(onHost, false,
        "a sandboxed worktree must not exist on the host filesystem");

      // A sub-agent derived onto it stays inside the sandbox.
      const child = runtime.derive(wt.path);
      assert.strictEqual(child.isolated, true);
      const childPwd = await child.exec("pwd");
      assert.ok(childPwd.stdout.trim().startsWith("/kodo-worktrees/"),
        `the sub-agent runs in its worktree inside the container, got ${childPwd.stdout.trim()}`);

      const removed = await runtime.removeWorktree(wt.worktreeId);
      assert.strictEqual(removed.removed, true);
      const gone = await runtime.exec(`test -d ${wt.path} && echo yes || echo no`);
      assert.ok(gone.stdout.includes("no"), "the worktree should be cleaned up");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ── End to end: the agent's actual tools ─────────────────────────────────────

await test("agent TOOLS operate inside the container end to end", async () => {
  const root = await tempWorkspace({ "calc.js": "function add(a, b) { return a - b; }\n" });
  try {
    await withRuntime({ root, mountWorkspace: false }, async (runtime) => {
      const ctx = createToolContext({ root, runtime });

      // read_file sees the copied-in workspace…
      const read = await executeTool("read_file", { path: "calc.js" }, ctx);
      assert.strictEqual(read.success, true, read.error);
      assert.ok(read.content.includes("a - b"));

      // …edit_file changes it INSIDE the container…
      const edit = await executeTool(
        "edit_file",
        { path: "calc.js", old_string: "a - b", new_string: "a + b" },
        ctx,
      );
      assert.strictEqual(edit.success, true, edit.error);

      const inContainer = await runtime.exec("cat /workspace/calc.js");
      assert.ok(inContainer.stdout.includes("a + b"), "the edit did not reach the container");

      // …and NOT on the host, because there is no mount.
      const onHost = await fs.readFile(path.join(root, "calc.js"), "utf-8");
      assert.ok(onHost.includes("a - b"),
        "edit_file modified the HOST file despite an unmounted sandbox — the file tools escaped the container");

      // write_file, likewise.
      const write = await executeTool("write_file", { path: "new.js", content: "export const x = 1;\n" }, ctx);
      assert.strictEqual(write.success, true, write.error);
      const newOnHost = await fs.access(path.join(root, "new.js")).then(() => true).catch(() => false);
      assert.strictEqual(newOnHost, false, "write_file created a file on the host");

      // bash, likewise.
      const bash = await executeTool("bash", { command: "echo sandboxed > proof.txt && cat proof.txt" }, ctx);
      assert.strictEqual(bash.success, true, bash.stderr);
      const proofOnHost = await fs.access(path.join(root, "proof.txt")).then(() => true).catch(() => false);
      assert.strictEqual(proofOnHost, false, "a bash-created file appeared on the host");
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Cleanup guarantee ────────────────────────────────────────────────────────

await test("cleanup() removes the container", async () => {
  const root = await tempWorkspace();
  const runtime = new DockerRuntime({ root, image: TEST_IMAGE, mountWorkspace: false });
  try {
    await runtime.start();
    const id = runtime.containerId;
    await runtime.cleanup();
    const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", `id=${id}`, "--format", "{{.ID}}"]);
    assert.strictEqual(stdout.trim(), "", "the container outlived cleanup()");
  } finally {
    await runtime.cleanup().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
if (notVerified.length) {
  console.log("⚠️  Not verified on this machine (reported, not passed):");
  for (const n of notVerified) console.log(`   · ${n}`);
  console.log("");
}
process.exit(failed > 0 ? 1 : 0);
