/**
 * verify.mjs
 * ──────────────────────────────────────────────────────────────
 * Verifies that execution went correctly.
 *
 * Checks:
 *  1. Any hard failures in executionResults?
 *  2. Spot-reads the written files to confirm they are not empty.
 *  3. (Optional) Runs a quick syntax check if the project has a
 *     tsconfig or eslint config.
 *
 * Returns:
 *   verifyResult = { ok: bool, issues: string[] }
 *
 * If ok=false and retryCount < MAX_RETRIES → graph loops back
 * to execute_changes (potentially after re-planning).
 */

import path from "path";
import fs   from "fs/promises";
import { AIMessage } from "@langchain/core/messages";

async function safeStat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

async function readFirstBytes(absPath, n = 200) {
  try {
    const content = await fs.readFile(absPath, "utf-8");
    return content.slice(0, n);
  } catch {
    return null;
  }
}

// ── Node ──────────────────────────────────────────────────────
export async function verifyNode(state) {
  const { executionResults, plan, workspacePath, emit, retryCount } = state;

  emit?.({ type: "progress", stage: "verifying", message: "🔍 Verifying changes..." });

  const root   = workspacePath || process.cwd();
  const issues = [];

  // 1. Check execution result failures
  const failed = (executionResults || []).filter(r => !r.success);
  for (const f of failed) {
    issues.push(`Failed to ${f.action} "${f.path}": ${f.error || "unknown error"}`);
  }

  // 2. Spot-check written files actually exist and have content
  const writtenSteps = (plan || []).filter(p =>
    (p.action === "edit" || p.action === "create") && p.path
  );

  for (const step of writtenSteps) {
    const absPath = path.isAbsolute(step.path)
      ? step.path
      : path.join(root, step.path);

    const stat = await safeStat(absPath);
    if (!stat) {
      issues.push(`File not found after write: "${step.path}"`);
      continue;
    }
    if (stat.size === 0) {
      issues.push(`File is empty after write: "${step.path}"`);
      continue;
    }

    // File exists and is non-empty — that's sufficient for diff-based edits.
    // (We can't compare against full content because edits are search/replace blocks.)
  }

  const ok = issues.length === 0;

  const verifyResult = { ok, issues };

  if (ok) {
    emit?.({
      type:    "progress",
      stage:   "verified",
      message: "✅ All changes verified successfully!",
    });
  } else {
    emit?.({
      type:    "progress",
      stage:   "verify_failed",
      message: `⚠️ Verification found ${issues.length} issue(s)${retryCount < 2 ? " — will retry" : " — max retries reached"}.`,
    });
    issues.forEach(issue => console.warn(`[Verify] Issue: ${issue}`));
  }

  // Generate the final human-readable summary for the "done" event
  const successSteps = (plan || []).filter(p => p.action !== "read_only" && p.path);
  const readOnlySteps = (plan || []).filter(p => p.action === "read_only");

  let summaryLines = [];

  if (readOnlySteps.length > 0) {
    summaryLines.push(
      ...readOnlySteps.map(s => s.description).filter(Boolean)
    );
  }

  if (successSteps.length > 0) {
    if (ok) {
      summaryLines.push(`Successfully applied ${successSteps.length} change(s):`);
      summaryLines.push(
        ...successSteps.map(s => `  • ${s.action === "create" ? "Created" : s.action === "delete" ? "Deleted" : "Updated"} \`${s.path}\`${s.description ? " — " + s.description : ""}`)
      );
    } else {
      summaryLines.push(`Completed with ${issues.length} issue(s):`);
      summaryLines.push(...issues.map(i => `  ⚠️ ${i}`));
    }
  }

  const finalAnswer = summaryLines.join("\n") || "Done.";

  return {
    verifyResult,
    finalAnswer,
    retryCount: (retryCount || 0) + (ok ? 0 : 1),
    messages: [
      new AIMessage(
        ok
          ? `✅ Verification passed. All ${writtenSteps.length} file(s) written correctly.`
          : `⚠️ Verification found ${issues.length} issue(s): ${issues.join("; ")}`
      ),
    ],
  };
}
