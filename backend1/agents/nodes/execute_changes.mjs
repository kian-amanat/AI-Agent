/**
 * execute_changes.mjs — DIFF-BASED
 * Applies search/replace edits to files. Saves undo snapshot first
 * (meta.json + .snap) in the exact format undo.service.mjs reads.
 */

import path from "path";
import fs   from "fs/promises";
import { fileURLToPath } from "url";
import { AIMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// backend1/agents/nodes/ → up 3 → ai-sandbox (matches undo.service.mjs)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

function normalizeId(prefix, id) {
  if (!id) return id;
  const p = `${prefix}_`;
  return id.startsWith(p) ? id : `${p}${id}`;
}

// ── Apply one search/replace to file content ──────────────────
// Returns { ok, content, error }
function applyEdit(fileContent, search, replace) {
  if (typeof search !== "string" || search.length === 0) {
    return { ok: false, content: fileContent, error: "empty search" };
  }

  const idx = fileContent.indexOf(search);
  if (idx === -1) {
    // Try a whitespace-tolerant match: collapse runs of spaces/tabs
    const norm = s => s.replace(/[ \t]+/g, " ");
    const normContent = norm(fileContent);
    const normSearch  = norm(search);
    const ni = normContent.indexOf(normSearch);
    if (ni === -1) {
      return { ok: false, content: fileContent, error: "search text not found" };
    }
    // Found only after normalisation — too risky to map back. Report miss.
    return { ok: false, content: fileContent, error: "search text not found (whitespace mismatch)" };
  }

  // Check uniqueness — if it appears more than once, refuse (ambiguous)
  const lastIdx = fileContent.lastIndexOf(search);
  if (lastIdx !== idx) {
    return { ok: false, content: fileContent, error: "search text is not unique (appears multiple times)" };
  }

  const newContent = fileContent.slice(0, idx) + replace + fileContent.slice(idx + search.length);
  return { ok: true, content: newContent, error: null };
}

// ── Save undo snapshot (meta.json + .snap) ────────────────────
async function saveUndoSnapshot(workspacePath, sessionId, requestId, plan) {
  try {
    const normSession = normalizeId("sess", sessionId);
    const normRequest = normalizeId("req", requestId);
    const snapshotDir = path.join(HISTORY_ROOT, normSession, normRequest);
    await fs.mkdir(snapshotDir, { recursive: true });

    const writableSteps = plan.filter(p =>
      (p.action === "edit" || p.action === "create" || p.action === "delete") && p.path
    );

    const metaFiles = [];
    for (const step of writableSteps) {
      const absPath = path.isAbsolute(step.path) ? step.path : path.join(workspacePath, step.path);
      let previousContent = null;
      let existedBefore   = true;
      try { previousContent = await fs.readFile(absPath, "utf-8"); }
      catch { existedBefore = false; }

      let snapshotPath = null;
      if (existedBefore && previousContent !== null) {
        const safeName = step.path.replace(/[/\\]/g, "__") + ".snap";
        const snapFile = path.join(snapshotDir, safeName);
        await fs.writeFile(snapFile, previousContent, "utf-8");
        snapshotPath = snapFile;
      }

      metaFiles.push({ relativePath: step.path, fullPath: absPath, existedBefore, snapshotPath });
    }

    await fs.writeFile(
      path.join(snapshotDir, "meta.json"),
      JSON.stringify({ sessionId: normSession, requestId: normRequest, workspacePath: workspacePath || null, createdAt: new Date().toISOString(), files: metaFiles }, null, 2),
      "utf-8"
    );
    console.log(`[Execute] 💾 Undo snapshot saved: ${snapshotDir}`);
  } catch (err) {
    console.warn("[Execute] ⚠️ Could not save undo snapshot:", err.message);
  }
}

async function readFileSafe(absPath) {
  try { return await fs.readFile(absPath, "utf-8"); }
  catch { return null; }
}

async function writeFileSafe(absPath, content) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf-8");
}

const ACTION_ICON = { edit: "✏️", create: "➕", delete: "🗑️", read_only: "👁️" };

export async function executeChangesNode(state) {
  const { plan, workspacePath, emit, retryCount, sessionId, requestId } = state;
  const root = workspacePath || process.cwd();

  if (!Array.isArray(plan) || plan.length === 0) {
    emit?.({ type: "progress", stage: "execute_skip", message: "⏩ No changes to execute." });
    return { executionResults: [] };
  }

  const actionable = plan.filter(p => p.action !== "read_only" && p.path);
  if (actionable.length === 0) {
    emit?.({ type: "progress", stage: "execute_skip", message: "ℹ️ Read-only — no file changes." });
    return { executionResults: [] };
  }

  if (sessionId && requestId) {
    await saveUndoSnapshot(root, sessionId, requestId, plan);
  }

  emit?.({
    type: "progress", stage: "executing",
    message: retryCount > 0 ? `🔄 Retry ${retryCount}…` : `⚙️ Applying ${actionable.length} change(s)…`,
  });

  const executionResults = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const icon = ACTION_ICON[step.action] || "📝";
    const absPath = path.isAbsolute(step.path) ? step.path : path.join(root, step.path);

    if (step.action === "read_only") {
      emit?.({ type: "progress", stage: "step", message: `${icon} [${i + 1}/${plan.length}] ${step.description}` });
      executionResults.push({ action: step.action, path: step.path, success: true, note: step.description });
      continue;
    }

    if (!step.path) {
      executionResults.push({ action: step.action, path: "", success: false, error: "No path" });
      continue;
    }

    emit?.({ type: "progress", stage: "step", message: `${icon} [${i + 1}/${plan.length}] ${step.action.toUpperCase()} ${step.path}` });

    let result = { success: false, error: "unknown" };

    try {
      if (step.action === "create") {
        await writeFileSafe(absPath, step.content || "");
        result = { success: true };
      } else if (step.action === "delete") {
        try { await fs.unlink(absPath); result = { success: true }; }
        catch (e) { result = { success: false, error: e.message }; }
      } else if (step.action === "edit") {
        const original = await readFileSafe(absPath);
        if (original === null) {
          result = { success: false, error: `File not found: ${step.path}` };
        } else if (!step.edits || step.edits.length === 0) {
          result = { success: false, error: "No edits provided" };
        } else {
          // Apply each search/replace sequentially
          let working = original;
          const editResults = [];
          for (let e = 0; e < step.edits.length; e++) {
            const { search, replace } = step.edits[e];
            const r = applyEdit(working, search, replace);
            editResults.push(r.ok);
            if (r.ok) {
              working = r.content;
            } else {
              console.warn(`[Execute] ⚠️ edit ${e + 1}/${step.edits.length} on ${step.path}: ${r.error}`);
            }
          }
          const applied = editResults.filter(Boolean).length;
          if (applied > 0) {
            await writeFileSafe(absPath, working);
            result = {
              success: true,
              note: `${applied}/${step.edits.length} edits applied`,
              partial: applied < step.edits.length,
            };
          } else {
            result = { success: false, error: `0/${step.edits.length} edits matched — file unchanged` };
          }
        }
      }
    } catch (err) {
      result = { success: false, error: err.message };
    }

    emit?.({ type: "file_change", action: step.action, path: step.path, success: result.success, error: result.error || null });
    executionResults.push({ action: step.action, path: step.path, success: result.success, error: result.error || null, description: step.description, note: result.note });

    if (result.success) console.log(`[Execute] ✅ ${step.action} ${step.path}${result.note ? " — " + result.note : ""}`);
    else                 console.error(`[Execute] ❌ ${step.action} ${step.path}: ${result.error}`);
  }

  const ok   = executionResults.filter(r => r.success).length;
  const fail = executionResults.filter(r => !r.success).length;

  emit?.({ type: "progress", stage: "executed", message: `✅ ${ok} change(s) applied${fail ? ` — ⚠️ ${fail} failed` : ""}.` });

  return {
    executionResults,
    retryCount: retryCount || 0,
    messages: [new AIMessage(`Execution: ${ok} succeeded, ${fail} failed.`)],
  };
}
