#!/usr/bin/env node
/**
 * bin/kodo.mjs — the `kodo` executable.
 *
 * Deliberately has NO static imports.
 *
 * ESM evaluates every static import before the module body runs, so a version
 * check written above an `import` statement executes *after* the thing it was
 * meant to guard. On Node 18 the friendly "Kodo needs 20.12" message never
 * appeared — the user got a SyntaxError or a TypeError from somewhere deep in
 * the agent instead, which is the exact failure this check exists to prevent.
 *
 * Dynamic `import()` runs when it is reached, so the guard genuinely comes
 * first. Everything else lives in src/, which the tests import directly.
 */

// Node 20.12 is the floor: process.loadEnvFile (used by core's env loader) and
// the fetch/AbortSignal behaviour the lifecycle manager relies on both land
// there.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  process.stderr.write(
    `kodo requires Node.js 20.12 or newer — this is ${process.version}.\n\n` +
    "  Upgrade Node, then reinstall:\n" +
    "    npm install -g kodo-agent\n\n" +
    "  If you use nvm:\n" +
    "    nvm install --lts && nvm use --lts\n",
  );
  // 3 = configuration error. Kept literal: importing the exit-code module here
  // would defeat the point of having no imports.
  process.exit(3);
}

const { main, reportError } = await import("../src/main.mjs");

// EPIPE is normal when stdout is a pipe that closed first (`kodo help | head`).
// Without this, that produces an unhandled error and a nonzero exit for what is
// completely ordinary shell usage.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = typeof code === "number" ? code : 0;
} catch (err) {
  process.exitCode = reportError(err);
}
