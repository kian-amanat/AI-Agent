#!/usr/bin/env node
/**
 * scripts/test-all.mjs — run every Kodo test suite and report all of them.
 *
 * Deliberately not `npm --prefix backend1 test && npm --prefix cli test`.
 * Chaining stops at the first failure, so one flaky suite hides every result
 * after it — and the two LIVE suites at the end of the core run drive a real
 * model against a real provider, which means they can fail for reasons that
 * have nothing to do with the code (rate limit, a weak model not picking a
 * tool, a network blip). Under `&&` that intermittently hid the entire CLI
 * suite, which is exactly when you most want to see it.
 *
 * Every suite runs. The summary says which failed. Exit status is non-zero if
 * any did, so CI still gates.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const SUITES = [
  { name: "core (backend1)", cwd: path.join(root, "backend1"), args: ["test"] },
  { name: "cli", cwd: path.join(root, "cli"), args: ["test"] },
  // Documentation is verified like code: every documented command and flag is
  // checked against the real parsers. Stale docs fail the build.
  { name: "docs vs implementation", cwd: root, args: ["run", "validate:docs"] },
];

const run = ({ name, cwd, args }) => new Promise((resolve) => {
  console.log(`\n${"═".repeat(70)}\n▶  ${name}\n${"═".repeat(70)}`);
  const child = spawn("npm", args, { cwd, stdio: "inherit", env: process.env });
  child.on("close", (code) => resolve({ name, code }));
  child.on("error", (err) => resolve({ name, code: 1, error: err.message }));
});

const results = [];
for (const suite of SUITES) results.push(await run(suite));

console.log(`\n${"═".repeat(70)}\n  SUMMARY\n${"═".repeat(70)}`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? "✅" : "❌"}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
}

const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.log(`\n  ${failed.length} suite(s) failed: ${failed.map((f) => f.name).join(", ")}\n`);
  console.log("  Note: the core suite ends with two LIVE model tests. They make real,");
  console.log("  billed provider calls and can fail on model behaviour rather than code.");
  console.log("  Check whether the failures are in those before assuming a regression.\n");
} else {
  console.log("\n  All suites passed.\n");
}

process.exit(failed.length ? 1 : 0);
