#!/usr/bin/env node
/**
 * tests/run.mjs — run every CLI test suite, reporting all failures.
 *
 * Deliberately not `a && b && c`: chaining stops at the first failure, so a
 * broken early suite hides everything after it. Every suite runs, and the
 * summary states which ones failed.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  "cli.test.mjs",
  "sessions.test.mjs",
  "sandbox.test.mjs",
  "provider-errors.test.mjs",
  "lifecycle.test.mjs",
  "e2e.test.mjs",
];

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
  child.on("close", (code) => resolve({ file, code }));
});

const results = [];
for (const suite of SUITES) {
  results.push(await run(suite));
}

const failed = results.filter((r) => r.code !== 0);
console.log("─".repeat(60));
if (failed.length) {
  console.log(`\n❌ ${failed.length}/${results.length} CLI suite(s) failed: ${failed.map((f) => f.file).join(", ")}\n`);
  process.exit(1);
}
console.log(`\n✅ all ${results.length} CLI suites passed\n`);
