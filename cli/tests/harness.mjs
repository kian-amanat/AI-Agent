/**
 * tests/harness.mjs — the shared test harness.
 *
 * Matches the assertion style already used in backend1/tests (plain node, no
 * framework, tick/cross output, non-zero exit on failure) so `npm test` stays
 * one consistent thing.
 *
 * Every test runs against a throwaway KODO_HOME. That is the whole reason the
 * home directory is overridable: these tests start and stop real servers, write
 * real runtime state and send real signals, and none of it may touch the
 * developer's own ~/.kodo or the server they have running.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

export { assert };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_BIN = path.resolve(__dirname, "..", "bin", "kodo.mjs");

let passed = 0;
let failed = 0;
const failures = [];

export async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
    failures.push({ name, message: err.message });
  }
}

export function section(title) {
  console.log(`\n📦 ${title}`);
}

export function summary() {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  return failed === 0 ? 0 : 1;
}

export function finish() {
  process.exit(summary());
}

/** A disposable KODO_HOME for one test. Always cleaned up, even on failure. */
export function withTempHome(fn) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kodo-test-"));
    const previous = process.env.KODO_HOME;
    process.env.KODO_HOME = home;
    try {
      await fn(home);
    } finally {
      if (previous === undefined) delete process.env.KODO_HOME;
      else process.env.KODO_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

/** A disposable workspace directory. */
export function tempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodo-ws-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

/**
 * Run the CLI as a real subprocess. Tests that assert on exit codes and stream
 * separation have to go through the actual binary — importing main() would test
 * a different thing than the one users run.
 */
export function runCli(args, { home, cwd, env = {}, timeoutMs = 60_000, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        ...(home ? { KODO_HOME: home } : {}),
        NO_COLOR: "1",
        ...env,
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, stdout, stderr: `${stderr}\n[test harness] timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    if (input !== null) { child.stdin.write(input); child.stdin.end(); }
    else child.stdin.end();

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy, or throw. Beats a fixed sleep in a lifecycle test. */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}
