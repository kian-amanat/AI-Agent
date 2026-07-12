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

// Detects lint/typecheck/test commands for ONE specific project directory (the directory
// that directly owns the package.json — not necessarily the workspace root). This project
// is a monorepo-style layout: backend1/ and chatbot/my-chatbot-ui/ each have their own
// package.json with their own scripts. Running commands from the wrong directory means
// "npm run lint --if-present" silently no-ops (missing script exits 0), producing a false
// "✅ verified" even though the actual project's real lint/typecheck never ran.
// relFilesInProject: paths of THIS turn's touched files, relative to projectDir. Lint is
// scoped to exactly these files (via a direct eslint invocation) rather than the whole
// project — a repo can carry pre-existing lint debt in files nobody touched this turn,
// and failing verification on unrelated errors would make every future edit permanently
// "unverifiable". Claude Code lints what it changed, not the entire codebase it didn't.
// Typecheck stays whole-project: TypeScript needs full program context for correct
// cross-file type resolution, so there's no safe way to scope it to individual files.
async function detectValidationCommandsForDir(projectDir, relFilesInProject = []) {
  const packageJsonPath = path.join(projectDir, "package.json");
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

  const lintableFiles = relFilesInProject.filter(f => /\.(tsx?|jsx?|mjs|cjs)$/i.test(f));
  if (scripts.lint && lintableFiles.length > 0) {
    commands.push({ kind: "lint", command: "npx", args: ["eslint", ...lintableFiles] });
  }

  if (scripts.typecheck) {
    commands.push({ kind: "typecheck", command: "npm", args: ["run", "typecheck"] });
  } else if (scripts["type-check"]) {
    commands.push({ kind: "typecheck", command: "npm", args: ["run", "type-check"] });
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

// Walk upward from a touched file's own directory to find the nearest ancestor directory
// that owns a package.json — the same resolution strategy Node/npm workspaces use. This is
// what makes verification monorepo-aware: a file edited under chatbot/my-chatbot-ui/ gets
// validated against THAT package.json, not whatever happens to sit at the workspace root.
async function findNearestPackageJson(startDir, stopAtDir) {
  let dir = startDir;
  const stop = path.resolve(stopAtDir);

  while (true) {
    const candidate = path.join(dir, "package.json");
    if (await safeStat(candidate)) return dir;

    if (path.resolve(dir) === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root without finding one
    dir = parent;
  }
}

// Groups touched files by the nearest project directory that owns them, so each project
// gets validated with its own lint/typecheck/test scripts run from its own directory
// (correct cwd matters — npm resolves package.json relative to cwd).
async function groupTouchedFilesByProject(root, touchedFilePaths) {
  const projectDirs = new Map(); // projectDir -> relative file paths[]

  for (const relPath of touchedFilePaths) {
    let absDir;
    try {
      absDir = path.dirname(safeResolvePath(root, relPath));
    } catch {
      continue;
    }

    const projectDir = (await findNearestPackageJson(absDir, root)) || root;
    if (!projectDirs.has(projectDir)) projectDirs.set(projectDir, []);
    projectDirs.get(projectDir).push(relPath);
  }

  return projectDirs;
}

export async function verifyNode(state) {
  const { executionResults, plan, workspacePath, emit, retryCount } = state;

  emit?.({ type: "progress", stage: "verifying", message: "🔍 Verifying changes..." });

  // Trace which attempt's results this verify call is actually judging — the final
  // user-facing summary is built from these, so if a stale set ever leaks through a
  // retry cycle, this line makes it immediately visible in the server log.
  console.log(
    `[Verify] attempt=${retryCount || 0} judging ${(executionResults || []).length} execution result(s): ` +
    (executionResults || []).map(r => `${r.action} ${r.path} ${r.success ? "ok" : `FAIL(${String(r.error || "").slice(0, 60)})`}`).join("; ")
  );

  const root = workspacePath || PROJECT_ROOT;
  const issues = [];
  const failedEdits = [];
  const touchedFiles = new Set();

  for (const r of executionResults || []) {
    if (r?.path) touchedFiles.add(r.path);

    // Partial edits (some patches applied, some anchors didn't match) count as
    // failures too: the step reports success=true because SOMETHING was written,
    // but part of the user's request silently vanished. Without this, verify sees
    // no issue, no retry fires, and the final answer says "Successfully applied"
    // for a half-done job. The failed anchors are already captured — feed them
    // into the same retry path a fully-failed edit uses.
    const isPartial = r.success && Array.isArray(r.failedPatches) && r.failedPatches.length > 0;

    if (!r.success || isPartial) {
      issues.push(
        isPartial
          ? `Partial edit on "${r.path}": ${r.failedPatches.length} planned patch(es) did not apply — part of the request was not completed`
          : `Failed to ${r.action} "${r.path}": ${r.error || "unknown error"}`
      );

      if (r.path) {
        try {
          const absPath = safeResolvePath(root, r.path);
          const currentContent = await readFileSafe(absPath);
          failedEdits.push({
            path: r.path,
            action: r.action,
            error: isPartial
              ? `${r.failedPatches.length} of the planned patches did not match the file — the other patches were already applied, so plan ONLY the missing change(s)`
              : r.error,
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
  const projectDirs = await groupTouchedFilesByProject(root, touchedFiles);

  if (projectDirs.size === 0) {
    // Nothing was actually written (e.g. all read_only) — fall back to the root project
    // so a lint/typecheck-only invocation (no file changes) still gets checked once.
    projectDirs.set(root, []);
  }

  for (const [projectDir, filesInProject] of projectDirs) {
    const relFilesInProject = filesInProject
      .map(f => {
        try { return path.relative(projectDir, safeResolvePath(root, f)); }
        catch { return null; }
      })
      .filter(Boolean);

    const { commands: validationCommands, skippedTestReason } = await detectValidationCommandsForDir(projectDir, relFilesInProject);
    const projectLabel = path.relative(root, projectDir) || ".";

    if (validationCommands.length === 0) {
      console.warn(`[Verify] No lint/typecheck/test scripts found for project "${projectLabel}" (touched: ${filesInProject.join(", ") || "none"})`);
    }

    if (skippedTestReason) {
      emit?.({
        type: "progress",
        stage: "verify_skip",
        message: `ℹ️ Skipping test validation for "${projectLabel}" (${skippedTestReason}).`,
      });
    }

    for (const cmd of validationCommands) {
      const result = await runCommand(cmd.command, cmd.args, projectDir, 120000);
      validationResults.push({ ...result, projectDir: projectLabel });

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
            message: `ℹ️ Test script in "${projectLabel}" is only a placeholder. Skipping test failure.`,
          });
          continue;
        }

        // Typecheck runs whole-project (tsc needs full program context), so its output
        // can include PRE-EXISTING errors in files this request never touched. Failing
        // the request on those is worse than useless: it triggers a retry that re-plans
        // an ALREADY-APPLIED edit against changed content, whose anchors then miss, and
        // the user sees "0/N patches matched" for work that actually succeeded. Only
        // fail on typecheck errors located in files THIS request wrote; log the rest
        // as pre-existing project debt.
        if (cmd.kind === "typecheck") {
          const errorFiles = [...new Set(
            [...combinedOutput.matchAll(/^([^\s(]+\.(?:tsx?|jsx?|mjs|cjs|ts|js))\(/gm)].map(m => m[1].replace(/\\/g, "/"))
          )];
          const touchedSet = new Set(relFilesInProject.map(f => f.replace(/\\/g, "/")));
          const errorsInTouched = errorFiles.filter(f => touchedSet.has(f));

          if (errorFiles.length > 0 && errorsInTouched.length === 0) {
            console.warn(
              `[Verify] Typecheck errors are all in files NOT touched by this request (${errorFiles.join(", ")}) — ` +
              `treating as pre-existing project debt, not a failure of this edit.`
            );
            emit?.({
              type: "progress",
              stage: "verify_skip",
              message: `ℹ️ Typecheck found pre-existing errors in unrelated files (${errorFiles.slice(0, 2).join(", ")}${errorFiles.length > 2 ? "…" : ""}) — not caused by this change.`,
            });
            continue;
          }
        }

        issues.push(`Validation failed in "${projectLabel}": ${result.command}`);
        if (combinedOutput.trim()) {
          issues.push(combinedOutput.trim());
        }
        break;
      }
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
  } else if (canRetry && touchedFiles.size > 0) {
    // Every edit APPLIED, but validation failed (typecheck/lint error in a touched
    // file). Without fresh context the retry planner re-reads the ORIGINAL pre-edit
    // file content, regenerates the same patches, and every anchor misses ("0/N
    // patches matched") because the change is already on disk. Give it the CURRENT
    // content and say so explicitly: the job now is fixing the validation errors,
    // not redoing the request.
    const validationSummary = issues.slice(0, 4).join("\n").slice(0, 1500);
    retryFileContext = [];
    for (const filePath of touchedFiles) {
      try {
        const absPath = safeResolvePath(root, filePath);
        const content = await readFileSafe(absPath);
        if (content) {
          retryFileContext.push({
            path: filePath,
            content: content.slice(0, 40000),
            summary:
              `RETRY: The previous patches were ALREADY APPLIED — the content below reflects them. ` +
              `Do NOT re-apply the original request. Fix ONLY these validation errors:\n${validationSummary}`,
            score: 200,
          });
        }
      } catch { /* skip unreadable */ }
    }
    if (retryFileContext.length === 0) retryFileContext = null;
    else console.log(`[Verify] Built validation-fix retry context for ${retryFileContext.length} file(s) (edits already applied)`);
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

  // Edits that "applied" but changed zero bytes (execute_changes noop flag) mean the
  // file already satisfied the request — say that, never "Successfully applied".
  const editResults = (executionResults || []).filter((r) => r.success && r.action !== "read_only");
  const allNoop = editResults.length > 0 && editResults.every((r) => r.noop);

  if (successSteps.length > 0) {
    if (ok && allNoop) {
      summaryLines.push("The code already matches what you asked for — no changes were needed:");
      summaryLines.push(...editResults.map((r) => `  • \`${r.path}\` already in the requested state`));
    } else if (ok) {
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
    // When the plan is empty, an upstream node may have already set a SPECIFIC
    // finalAnswer explaining why (e.g. plan_changes' "API token quota may be
    // exhausted" after an empty LLM response). The finalAnswer state channel has
    // no reducer — last write wins — so writing the generic fallback here would
    // clobber the real diagnosis and show the user a useless "could not determine
    // what to change" instead of the actual cause. Preserve it.
    if (noSteps && state.finalAnswer) {
      result.finalAnswer = state.finalAnswer;
    } else {
      result.finalAnswer =
        summaryLines.join("\n") ||
        (allReadOnly
          ? "This feature already exists in the codebase — no changes were needed."
          : noSteps
          ? "The AI could not determine what to change. Try rephrasing with the specific file name or component you want edited."
          : "Done.");
    }
  }

  return result;
}