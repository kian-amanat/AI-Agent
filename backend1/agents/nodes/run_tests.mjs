/**
 * run_tests.mjs
 * Standalone test-runner node.
 * - Discovers all package.json files in the project (skips node_modules etc.)
 * - Runs lint + typecheck + test in each package that has real scripts
 * - Emits structured progress events and returns a testReport in state
 */

import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { AIMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build",
  "coverage", ".turbo", ".cache", "out", ".vscode", "uploads", ".agent-history",
]);

function isPlaceholderTestScript(script = "") {
  const s = String(script || "").trim();
  return (
    /error:\s*no test specified/i.test(s) ||
    /echo\s+["']?error:\s*no test specified["']?\s*&&\s*exit\s+1/i.test(s)
  );
}

function runCommand(command, args, cwd, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, command: `${command} ${args.join(" ")}` });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + err.message, command: `${command} ${args.join(" ")}` });
    });
  });
}

async function findPackages(root) {
  const packages = [];

  async function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (!entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);

      // Check for package.json in this directory
      try {
        const pkgPath = path.join(abs, "package.json");
        const raw = await fs.readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(raw);
        packages.push({ dir: abs, rel: path.relative(root, abs), scripts: pkg.scripts || {}, name: pkg.name || entry.name });
      } catch {
        // no package.json here, keep walking
        await walk(abs, depth + 1);
        continue;
      }

      // Found a package — still walk its subdirs (monorepo support)
      await walk(abs, depth + 1);
    }
  }

  // Also check root itself
  try {
    const pkgPath = path.join(root, "package.json");
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    packages.push({ dir: root, rel: ".", scripts: pkg.scripts || {}, name: pkg.name || "root" });
  } catch {}

  await walk(root);
  return packages;
}

function buildCommands(pkg) {
  const cmds = [];
  const s = pkg.scripts;

  if (s.lint)                    cmds.push({ kind: "lint",      args: ["run", "lint"] });
  if (s.typecheck)               cmds.push({ kind: "typecheck", args: ["run", "typecheck"] });
  else if (s["type-check"])      cmds.push({ kind: "typecheck", args: ["run", "type-check"] });
  if (s.test && !isPlaceholderTestScript(s.test))
                                 cmds.push({ kind: "test",      args: ["run", "test"] });
  if (s["test:unit"])            cmds.push({ kind: "test:unit", args: ["run", "test:unit"] });
  if (s["test:integration"])     cmds.push({ kind: "test:int",  args: ["run", "test:integration"] });

  return cmds;
}

export async function runTestsNode(state) {
  const { workspacePath, userMessage, emit } = state;
  const root = workspacePath || PROJECT_ROOT;

  const msg = String(userMessage || "").toLowerCase();

  // Detect which package the user is asking about (optional filter)
  const filter = msg.match(/\b(frontend|chatbot|backend|backend1|ui|server)\b/)?.[1] || null;

  emit?.({ type: "progress", stage: "test_discover", message: "🧪 Discovering packages…" });

  const packages = await findPackages(root);
  const relevant = filter
    ? packages.filter((p) => p.rel.toLowerCase().includes(filter) || p.name.toLowerCase().includes(filter))
    : packages;

  if (relevant.length === 0) {
    emit?.({ type: "progress", stage: "test_done", message: "⚠️ No packages with test scripts found." });
    return {
      testReport: { ok: true, packages: [], summary: "No testable packages found." },
      messages: [new AIMessage("No packages with test scripts found.")],
    };
  }

  emit?.({
    type: "progress",
    stage: "test_start",
    message: `🧪 Running tests in ${relevant.length} package(s): ${relevant.map((p) => p.name).join(", ")}`,
  });

  const packageReports = [];
  let allPassed = true;

  for (const pkg of relevant) {
    const cmds = buildCommands(pkg);
    if (cmds.length === 0) continue;

    emit?.({ type: "progress", stage: "test_package", message: `📦 [${pkg.name}] Running ${cmds.length} script(s)…` });

    const cmdResults = [];
    let pkgPassed = true;

    for (const cmd of cmds) {
      emit?.({ type: "progress", stage: "test_cmd", message: `  ▶ ${pkg.name}: npm ${cmd.args.join(" ")}` });

      const result = await runCommand("npm", cmd.args, pkg.dir, 60_000);
      cmdResults.push({ kind: cmd.kind, ...result });

      if (!result.ok) {
        pkgPassed = false;
        allPassed = false;
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-2000);
        emit?.({
          type: "progress",
          stage: "test_fail",
          message: `  ❌ ${pkg.name}: ${cmd.kind} failed\n${output}`,
        });
        break; // stop on first failure in this package
      } else {
        emit?.({ type: "progress", stage: "test_pass", message: `  ✅ ${pkg.name}: ${cmd.kind} passed` });
      }
    }

    packageReports.push({ name: pkg.name, rel: pkg.rel, passed: pkgPassed, results: cmdResults });
  }

  const summary = packageReports
    .map((p) => `${p.passed ? "✅" : "❌"} ${p.name} (${p.rel})`)
    .join("\n");

  emit?.({
    type: "progress",
    stage: "test_done",
    message: allPassed
      ? `✅ All tests passed.\n${summary}`
      : `❌ Some tests failed.\n${summary}`,
  });

  console.log(`[RunTests] ${allPassed ? "PASS" : "FAIL"} — ${packageReports.length} package(s)`);

  return {
    testReport: { ok: allPassed, packages: packageReports, summary },
    messages: [
      new AIMessage(
        `Test run complete (${allPassed ? "ALL PASSED" : "FAILURES DETECTED"}):\n${summary}`
      ),
    ],
    finalAnswer: allPassed
      ? `All tests passed:\n${summary}`
      : `Tests failed:\n${summary}\n\nCheck the output above for details.`,
  };
}
