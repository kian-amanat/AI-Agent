/**
 * verify.mjs
 * Verifies file results and runs lightweight validation commands when possible.
 * Skips placeholder npm test scripts so verification does not fail on default setups.
 */

import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { AIMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

async function safeStat(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readFileSafe(absPath) {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

function isInsideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeResolvePath(root, filePath) {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(root, filePath);

  if (!isInsideRoot(root, resolved) && resolved !== root) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  return resolved;
}

function runCommand(command, args, cwd, timeoutMs = 120000) {
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
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 4000);
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        signal,
        stdout,
        stderr,
        command: `${command} ${args.join(" ")}`,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        signal: null,
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + err.message,
        command: `${command} ${args.join(" ")}`,
      });
    });
  });
}

function isPlaceholderTestScript(script = "") {
  const s = String(script || "").trim();

  return (
    /error:\s*no test specified/i.test(s) ||
    /echo\s+["']?error:\s*no test specified["']?\s*&&\s*exit\s+1/i.test(s) ||
    (/no test specified/i.test(s) && /exit\s+1/i.test(s))
  );
}

async function detectValidationCommands(workspacePath) {
  const packageJsonPath = path.join(workspacePath, "package.json");
  const stat = await safeStat(packageJsonPath);

  if (!stat) {
    return {
      commands: [],
      skippedTestReason: "package.json not found",
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
  } catch {
    return {
      commands: [],
      skippedTestReason: "package.json could not be parsed",
    };
  }

  const scripts = pkg?.scripts || {};
  const commands = [];

  if (scripts.lint) {
    commands.push({ kind: "lint", command: "npm", args: ["run", "lint"] });
  } else {
    commands.push({ kind: "lint", command: "npm", args: ["run", "lint", "--if-present"] });
  }

  if (scripts.typecheck) {
    commands.push({ kind: "typecheck", command: "npm", args: ["run", "typecheck"] });
  } else if (scripts["type-check"]) {
    commands.push({ kind: "typecheck", command: "npm", args: ["run", "type-check"] });
  } else {
    commands.push({ kind: "typecheck", command: "npm", args: ["run", "typecheck", "--if-present"] });
  }

  const hasRealTestScript = Boolean(scripts.test) && !isPlaceholderTestScript(scripts.test);
  if (hasRealTestScript) {
    commands.push({ kind: "test", command: "npm", args: ["test"] });
  }

  return {
    commands,
    skippedTestReason: scripts.test && isPlaceholderTestScript(scripts.test)
      ? "placeholder npm test script"
      : "",
  };
}

export async function verifyNode(state) {
  const { executionResults, plan, workspacePath, emit, retryCount } = state;

  emit?.({ type: "progress", stage: "verifying", message: "🔍 Verifying changes..." });

  const root = workspacePath || PROJECT_ROOT;
  const issues = [];
  const failedEdits = [];
  const touchedFiles = new Set();

  for (const r of executionResults || []) {
    if (r?.path) touchedFiles.add(r.path);

    if (!r.success) {
      issues.push(`Failed to ${r.action} "${r.path}": ${r.error || "unknown error"}`);

      if (r.path) {
        try {
          const absPath = safeResolvePath(root, r.path);
          const currentContent = await readFileSafe(absPath);
          failedEdits.push({
            path: r.path,
            action: r.action,
            error: r.error,
            currentContent: currentContent ? currentContent.slice(0, 40000) : null,
            // Pass through the failed search anchors from execute_changes for retry context
            failedPatches: r.failedPatches || [],
          });
        } catch (err) {
          issues.push(`Invalid failed path "${r.path}": ${err.message}`);
        }
      }
    }
  }

  // Fix: all-read_only on a retry is "gave up", not success.
  // execute_changes returns executionResults:[] when the plan has zero actionable steps,
  // which makes issues.length===0 → ok=true → "✅ Verification passed" — a false positive.
  // Surface it honestly so the user and the retry loop know nothing was done.
  const actionableInPlan = (plan || []).filter(p => p.action !== "read_only");
  if (actionableInPlan.length === 0 && (retryCount || 0) > 0) {
    issues.push(
      "Model could not generate an actionable patch after retry — " +
      "the search anchor may not match the current file. Try rephrasing with a more specific description of what to change."
    );
  }

  const writtenSteps = (plan || []).filter(
    (p) => (p.action === "edit" || p.action === "create" || p.action === "rewrite_file") && p.path
  );

  for (const step of writtenSteps) {
    try {
      const absPath = safeResolvePath(root, step.path);
      const stat = await safeStat(absPath);

      if (!stat) {
        issues.push(`File not found after write: "${step.path}"`);
      } else if (stat.size === 0) {
        issues.push(`File is empty after write: "${step.path}"`);
      } else {
        touchedFiles.add(step.path);
      }
    } catch (err) {
      issues.push(`Invalid written file path "${step.path}": ${err.message}`);
    }
  }

  for (const filePath of touchedFiles) {
    try {
      const absPath = safeResolvePath(root, filePath);
      const content = await readFileSafe(absPath);
      if (content == null) {
        issues.push(`Could not read touched file: "${filePath}"`);
      }
    } catch (err) {
      issues.push(`Invalid touched file path "${filePath}": ${err.message}`);
    }
  }

  const validationResults = [];
  const { commands: validationCommands, skippedTestReason } = await detectValidationCommands(root);

  if (skippedTestReason) {
    emit?.({
      type: "progress",
      stage: "verify_skip",
      message: `ℹ️ Skipping test validation (${skippedTestReason}).`,
    });
  }

  for (const cmd of validationCommands) {
    const result = await runCommand(cmd.command, cmd.args, root, 120000);
    validationResults.push(result);

    if (!result.ok) {
      const combinedOutput = [
        result.stdout ? result.stdout.slice(-3000) : "",
        result.stderr ? result.stderr.slice(-3000) : "",
      ]
        .filter(Boolean)
        .join("\n");

      if (
        cmd.kind === "test" &&
        /error:\s*no test specified/i.test(combinedOutput)
      ) {
        emit?.({
          type: "progress",
          stage: "verify_skip",
          message: "ℹ️ Test script is only a placeholder. Skipping test failure.",
        });
        continue;
      }

      issues.push(`Validation failed: ${result.command}`);
      if (combinedOutput.trim()) {
        issues.push(combinedOutput.trim());
      }
      break;
    }
  }

  const ok = issues.length === 0;
  // MAX_RETRIES must match kodo_graph.mjs's verifyEdge, and canRetry must be computed
  // from the POST-increment count (nextRetryCount) — verifyEdge gates on the retryCount
  // this node returns, not the one it received. Using the pre-increment value here caused
  // canRetry=true right when the graph was actually about to stop, which skipped setting
  // finalAnswer and left the user with an empty response instead of the failure message.
  const MAX_RETRIES = 2;
  const nextRetryCount = (retryCount || 0) + (ok ? 0 : 1);
  const canRetry = !ok && nextRetryCount < MAX_RETRIES;

  let retryFileContext = null;
  if (canRetry && failedEdits.length > 0) {
    retryFileContext = failedEdits
      .map((fe) => {
        // Include the exact search text that didn't match — the model can see what it tried
        // and pick a different, correct anchor instead of guessing blind (Claude Code approach).
        const anchorHints = (fe.failedPatches || [])
          .filter(p => p.search)
          .map(p => `  • [${p.kind}] searched for: "${p.search.slice(0, 150).replace(/\n/g, "↵")}"`)
          .join("\n");

        const summary = anchorHints
          ? `RETRY: Previous edit failed with "${fe.error}".\nSearch anchors that did NOT match the file:\n${anchorHints}\nUse the CURRENT content below — find the correct location and use a DIFFERENT anchor.`
          : `RETRY: Previous edit failed with "${fe.error}". Use the CURRENT content below as source of truth.`;

        return { path: fe.path, content: fe.currentContent, summary, score: 200 };
      })
      .filter((fe) => fe.content);

    console.log(`[Verify] Built retry context for ${retryFileContext.length} file(s)`);
  }

  if (ok) {
    emit?.({ type: "progress", stage: "verified", message: "✅ All changes verified!" });
  } else if (canRetry) {
    emit?.({
      type: "progress",
      stage: "verify_retry",
      message: `⚠️ ${issues.length} issue(s) — retrying with fresh file content...`,
    });
    issues.forEach((i) => console.warn(`[Verify] ${i}`));
  } else {
    emit?.({
      type: "progress",
      stage: "verify_failed",
      message: `⚠️ ${issues.length} issue(s) — max retries reached.`,
    });
    issues.forEach((i) => console.warn(`[Verify] ${i}`));
  }

  const successSteps = (plan || []).filter((p) => p.action !== "read_only" && p.path);
  const readOnlySteps = (plan || []).filter((p) => p.action === "read_only");
  const summaryLines = [];

  if (readOnlySteps.length > 0) {
    summaryLines.push(...readOnlySteps.map((s) => s.description).filter(Boolean));
  }

  if (successSteps.length > 0) {
    if (ok) {
      summaryLines.push(`Successfully applied ${successSteps.length} change(s):`);
      summaryLines.push(
        ...successSteps.map((s) =>
          `  • ${s.action === "create" ? "Created" : s.action === "delete" ? "Deleted" : "Updated"} \`${s.path}\`${s.description ? " — " + s.description : ""}`
        )
      );
    } else {
      summaryLines.push(`Completed with ${issues.length} issue(s):`);
      summaryLines.push(...issues.map((i) => `  ⚠️ ${i}`));
    }
  }

  const result = {
    verifyResult: { ok, issues, validationResults },
    retryCount: nextRetryCount,
    messages: [
      new AIMessage(
        ok
          ? "✅ Verification passed."
          : `⚠️ ${issues.length} issue(s): ${issues.join("; ")}`
      ),
    ],
  };

  if (canRetry && retryFileContext && retryFileContext.length > 0) {
    result.fileContext = retryFileContext;
  }

  if (ok || !canRetry) {
    const allReadOnly = successSteps.length === 0 && readOnlySteps.length > 0;
    const noSteps = (plan || []).length === 0;
    result.finalAnswer =
      summaryLines.join("\n") ||
      (allReadOnly
        ? "This feature already exists in the codebase — no changes were needed."
        : noSteps
        ? "The AI could not determine what to change. Try rephrasing with the specific file name or component you want edited."
        : "Done.");
  }

  return result;
}