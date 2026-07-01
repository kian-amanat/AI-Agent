/**
 * execute_changes.mjs
 * Applies patch plans safely.
 *
 * Supports:
 * - rewrite_file
 * - replace_text
 * - replace_block
 * - insert_before
 * - insert_after
 * - delete_text
 *
 * Also supports the older edits[] array.
 */

import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { AIMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

function normalizeId(prefix, id) {
  if (!id) return id;
  const p = `${prefix}_`;
  return id.startsWith(p) ? id : `${p}${id}`;
}

function isInsideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeResolvePath(root, filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("Invalid file path");
  }

  if (path.isAbsolute(filePath)) {
    const normalized = path.normalize(filePath);
    if (!isInsideRoot(root, normalized)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }
    return normalized;
  }

  const resolved = path.resolve(root, filePath);
  if (!isInsideRoot(root, resolved) && resolved !== root) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  return resolved;
}

function ensureParentDir(absPath) {
  return fs.mkdir(path.dirname(absPath), { recursive: true });
}

async function readFileSafe(absPath) {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function findFileByPartialPath(root, partialPath) {
  const target = String(partialPath || "").replace(/\\/g, "/").trim();
  if (!target) return null;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;

      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(abs);
        if (found) return found;
      } else {
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        if (rel === target || rel.endsWith(target)) return abs;
      }
    }

    return null;
  }

  return walk(root);
}

async function writeFileAtomic(absPath, content) {
  await ensureParentDir(absPath);
  const tmpPath = `${absPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, absPath);
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function findUniqueExact(content, needle) {
  const idx = content.indexOf(needle);
  if (idx === -1) return { ok: false, error: "search text not found" };

  const lastIdx = content.lastIndexOf(needle);
  if (lastIdx !== idx) {
    return { ok: false, error: "search text is not unique" };
  }

  return { ok: true, index: idx };
}

function findUniqueNormalizedBlock(content, needle) {
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedNeedle) return { ok: false, error: "empty search text" };

  const lines = String(content || "").split("\n");
  const needleLines = normalizedNeedle.split("\n").map((l) => l.trim()).filter(Boolean);

  if (needleLines.length === 0) return { ok: false, error: "empty search text" };

  for (let start = 0; start < lines.length; start++) {
    let si = 0;
    let end = start;

    while (end < lines.length && si < needleLines.length) {
      const current = lines[end].trim();
      if (current === "" && needleLines[si] !== "") {
        end++;
        continue;
      }

      if (current === needleLines[si]) {
        si++;
        end++;
      } else {
        break;
      }
    }

    if (si === needleLines.length) {
      return { ok: true, start, end };
    }
  }

  return { ok: false, error: "block not found" };
}

function applyReplaceText(content, search, replace) {
  if (typeof search !== "string" || !search.trim()) {
    return { ok: false, content, error: "empty search" };
  }

  const exact = findUniqueExact(content, search);
  if (exact.ok) {
    const newContent =
      content.slice(0, exact.index) +
      replace +
      content.slice(exact.index + search.length);

    return { ok: true, content: newContent, error: null, note: "exact match" };
  }

  const block = findUniqueNormalizedBlock(content, search);
  if (block.ok) {
    const lines = content.split("\n");
    const indent = lines[block.start]?.match(/^(\s*)/)?.[1] || "";
    const replacementLines = String(replace || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => (line.length ? indent + line.replace(/^\s+/, "") : line));

    lines.splice(block.start, block.end - block.start, ...replacementLines);
    return {
      ok: true,
      content: lines.join("\n"),
      error: null,
      note: "normalized block match",
    };
  }

  return { ok: false, content, error: "search text not found" };
}

function applyInsertBefore(content, anchor, insertText) {
  if (!anchor || !String(anchor).trim()) {
    return { ok: false, content, error: "missing anchor" };
  }

  const idx = content.indexOf(anchor);
  if (idx === -1) return { ok: false, content, error: "anchor not found" };

  const lastIdx = content.lastIndexOf(anchor);
  if (lastIdx !== idx) return { ok: false, content, error: "anchor is not unique" };

  return {
    ok: true,
    content: content.slice(0, idx) + insertText + content.slice(idx),
    error: null,
  };
}

function applyInsertAfter(content, anchor, insertText) {
  if (!anchor || !String(anchor).trim()) {
    return { ok: false, content, error: "missing anchor" };
  }

  const idx = content.indexOf(anchor);
  if (idx === -1) return { ok: false, content, error: "anchor not found" };

  const lastIdx = content.lastIndexOf(anchor);
  if (lastIdx !== idx) return { ok: false, content, error: "anchor is not unique" };

  const insertAt = idx + anchor.length;
  return {
    ok: true,
    content: content.slice(0, insertAt) + insertText + content.slice(insertAt),
    error: null,
  };
}

function applyDeleteText(content, search) {
  return applyReplaceText(content, search, "");
}

function applyRewriteFile(_content, nextContent) {
  return {
    ok: true,
    content: String(nextContent || ""),
    error: null,
    note: "rewrite_file",
  };
}

function normalizePatch(patch) {
  if (!patch || typeof patch !== "object") return null;

  const kind = String(patch.kind || patch.type || "").trim();
  if (!kind) return null;

  return {
    kind,
    search: String(patch.search || patch.anchor || patch.before || "").trim(),
    replace: String(patch.replace || patch.content || patch.after || "").replace(/\r\n/g, "\n"),
    content: String(patch.content || "").replace(/\r\n/g, "\n"),
    anchor: String(patch.anchor || "").trim(),
    before: String(patch.before || "").replace(/\r\n/g, "\n"),
    after: String(patch.after || "").replace(/\r\n/g, "\n"),
  };
}

function extractPatches(step) {
  const patches = [];

  if (Array.isArray(step?.patches)) {
    for (const p of step.patches) {
      const normalized = normalizePatch(p);
      if (normalized) patches.push(normalized);
    }
  }

  if (Array.isArray(step?.edits)) {
    for (const e of step.edits) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.search !== "string" || typeof e.replace !== "string") continue;
      patches.push({
        kind: "replace_text",
        search: e.search,
        replace: e.replace,
        content: "",
        anchor: "",
        before: "",
        after: "",
      });
    }
  }

  return patches;
}

function applyOnePatch(content, patch) {
  switch (patch.kind) {
    case "rewrite_file":
      return applyRewriteFile(content, patch.content || patch.replace || "");

    case "replace_text":
    case "replace_block": {
      const search = patch.search || patch.before || patch.anchor;
      const replace = patch.replace || patch.after || patch.content || "";
      return applyReplaceText(content, search, replace);
    }

    case "insert_before":
      return applyInsertBefore(content, patch.anchor || patch.search, patch.content || patch.replace || patch.after || "");

    case "insert_after":
      return applyInsertAfter(content, patch.anchor || patch.search, patch.content || patch.replace || patch.after || "");

    case "delete_text":
      return applyDeleteText(content, patch.search || patch.anchor || patch.before);

    default:
      return { ok: false, content, error: `unknown patch kind: ${patch.kind}` };
  }
}

async function saveUndoSnapshot(workspacePath, sessionId, requestId, plan) {
  try {
    const normSession = normalizeId("sess", sessionId);
    const normRequest = normalizeId("req", requestId);
    const snapshotDir = path.join(HISTORY_ROOT, normSession, normRequest);

    await fs.mkdir(snapshotDir, { recursive: true });

    const writableSteps = plan.filter((p) =>
      (p.action === "edit" || p.action === "create" || p.action === "delete") && p.path
    );

    const metaFiles = [];

    for (const step of writableSteps) {
      let absPath = safeResolvePath(workspacePath, step.path);
      let previousContent = null;
      let existedBefore = true;

      try {
        previousContent = await fs.readFile(absPath, "utf-8");
      } catch {
        const resolved = await findFileByPartialPath(PROJECT_ROOT, step.path);
        if (resolved) {
          absPath = resolved;
          try {
            previousContent = await fs.readFile(absPath, "utf-8");
          } catch {
            existedBefore = false;
          }
        } else {
          existedBefore = false;
        }
      }

      let snapshotPath = null;
      if (existedBefore && previousContent !== null) {
        const safeName = step.path.replace(/[/\\]/g, "__") + ".snap";
        const snapFile = path.join(snapshotDir, safeName);
        await fs.writeFile(snapFile, previousContent, "utf-8");
        snapshotPath = snapFile;
      }

      metaFiles.push({
        relativePath: step.path,
        fullPath: absPath,
        existedBefore,
        snapshotPath,
      });
    }

    await fs.writeFile(
      path.join(snapshotDir, "meta.json"),
      JSON.stringify(
        {
          sessionId: normSession,
          requestId: normRequest,
          workspacePath: workspacePath || null,
          createdAt: new Date().toISOString(),
          files: metaFiles,
        },
        null,
        2
      ),
      "utf-8"
    );

    console.log(`[Execute] Undo snapshot saved: ${snapshotDir}`);
  } catch (err) {
    console.warn("[Execute] Could not save undo snapshot:", err.message);
  }
}

const ACTION_ICON = { edit: "✏️", create: "➕", delete: "🗑️", read_only: "👁️" };

export async function executeChangesNode(state) {
  const { plan, workspacePath, emit, retryCount, sessionId, requestId } = state;
  const root = workspacePath || process.cwd();

  if (!Array.isArray(plan) || plan.length === 0) {
    emit?.({ type: "progress", stage: "execute_skip", message: "⏩ No changes to execute." });
    return { executionResults: [] };
  }

  const actionable = plan.filter((p) => p.action !== "read_only" && p.path);
  if (actionable.length === 0) {
    emit?.({ type: "progress", stage: "execute_skip", message: "ℹ️ Read-only — no file changes." });
    return { executionResults: [] };
  }

  if (sessionId && requestId) {
    await saveUndoSnapshot(root, sessionId, requestId, plan);
  }

  emit?.({
    type: "progress",
    stage: "executing",
    message: retryCount > 0 ? `🔄 Retry ${retryCount}…` : `⚙️ Applying ${actionable.length} change(s)…`,
  });

  const executionResults = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const icon = ACTION_ICON[step.action] || "📝";

    if (step.action === "read_only") {
      emit?.({
        type: "progress",
        stage: "step",
        message: `${icon} [${i + 1}/${plan.length}] ${step.description}`,
      });
      executionResults.push({
        action: step.action,
        path: step.path,
        success: true,
        note: step.description,
      });
      continue;
    }

    if (!step.path) {
      executionResults.push({ action: step.action, path: "", success: false, error: "No path" });
      continue;
    }

    let absPath;
    try {
      absPath = safeResolvePath(root, step.path);
    } catch (err) {
      executionResults.push({
        action: step.action,
        path: step.path,
        success: false,
        error: err.message,
      });
      emit?.({ type: "file_change", action: step.action, path: step.path, success: false, error: err.message });
      continue;
    }

    emit?.({
      type: "progress",
      stage: "step",
      message: `${icon} [${i + 1}/${plan.length}] ${step.action.toUpperCase()} ${step.path}`,
    });

    let result = { success: false, error: "unknown" };

    try {
      if (step.action === "create") {
        await writeFileAtomic(absPath, String(step.content || ""));
        result = { success: true };
      } else if (step.action === "delete") {
        try {
          await fs.unlink(absPath);
          result = { success: true };
        } catch (e) {
          result = { success: false, error: e.message };
        }
      } else if (step.action === "edit") {
        let original = await readFileSafe(absPath);

        if (original === null) {
          const resolved = await findFileByPartialPath(PROJECT_ROOT, step.path);
          if (resolved) {
            absPath = resolved;
            original = await readFileSafe(absPath);
            console.log(`[Execute] Resolved "${step.path}" → "${path.relative(root, absPath)}"`);
          }
        }

        if (original === null) {
          result = { success: false, error: `File not found: ${step.path}` };
        } else {
          const patches = extractPatches(step);

          if (!patches.length) {
            result = { success: false, error: "No patches provided" };
          } else {
            let working = original;
            const patchResults = [];

            for (let p = 0; p < patches.length; p++) {
              const patch = patches[p];
              const applied = applyOnePatch(working, patch);

              patchResults.push(applied.ok);

              if (applied.ok) {
                working = applied.content;
              } else {
                console.warn(`[Execute] Patch ${p + 1}/${patches.length} on ${step.path}: ${applied.error}`);
              }
            }

            const appliedCount = patchResults.filter(Boolean).length;

            if (appliedCount > 0) {
              await writeFileAtomic(absPath, working);
              result = {
                success: true,
                note: `${appliedCount}/${patches.length} patch(es) applied`,
                partial: appliedCount < patches.length,
              };
            } else {
              result = {
                success: false,
                error: `0/${patches.length} patches matched — file unchanged`,
              };
            }
          }
        }
      } else {
        result = { success: false, error: `Unknown action: ${step.action}` };
      }
    } catch (err) {
      result = { success: false, error: err.message };
    }

    emit?.({
      type: "file_change",
      action: step.action,
      path: step.path,
      success: result.success,
      error: result.error || null,
    });

    executionResults.push({
      action: step.action,
      path: step.path,
      success: result.success,
      error: result.error || null,
      description: step.description,
      note: result.note,
    });

    if (result.success) console.log(`[Execute] ✅ ${step.action} ${step.path}${result.note ? " — " + result.note : ""}`);
    else console.error(`[Execute] ❌ ${step.action} ${step.path}: ${result.error}`);
  }

  const ok = executionResults.filter((r) => r.success).length;
  const fail = executionResults.filter((r) => !r.success).length;

  emit?.({
    type: "progress",
    stage: "executed",
    message: `✅ ${ok} change(s) applied${fail ? ` — ⚠️ ${fail} failed` : ""}.`,
  });

  return {
    executionResults,
    retryCount: retryCount || 0,
    messages: [new AIMessage(`Execution: ${ok} succeeded, ${fail} failed.`)],
  };
}