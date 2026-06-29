/**
 * services/workingset.mjs
 * ──────────────────────────────────────────────────────────────
 * Tier 2 memory: a rolling "working set" of recently touched files
 * per session, each with a short summary of what was done.
 *
 * Stored as a JSON string in the existing `session_memory` table
 * under a new column `working_set` (added automatically if missing).
 *
 * Shape stored:
 *   [
 *     { path: "app/components/chat/ChatSidebar.tsx",
 *       summary: "replaced collapse icon with icon.png",
 *       lastTouched: "2026-06-28T22:11:00Z",
 *       touchCount: 3 },
 *     ...
 *   ]
 *
 * Most-recently-touched file is always first.
 */

import db from "../db.mjs";

const MAX_FILES = 6;
const TABLE = "session_memory";

// ── Ensure the column exists ──────────────────────────────────
function ensureColumn() {
  try {
    const cols = db.prepare(`PRAGMA table_info(${TABLE})`).all();
    const hasCol = cols.some(c => c.name === "working_set");
    if (!hasCol) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN working_set TEXT`).run();
      console.log("[WorkingSet] Added working_set column to session_memory table");
    }
  } catch (err) {
    console.warn("[WorkingSet] ensureColumn failed:", err.message);
  }
}
ensureColumn();

// ── Read the working set for a session ────────────────────────
export function getWorkingSet(sessionId) {
  if (!sessionId) return [];
  try {
    const row = db
      .prepare(`SELECT working_set FROM ${TABLE} WHERE session_id = ?`)
      .get(sessionId);
    if (!row?.working_set) return [];
    const parsed = JSON.parse(row.working_set);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Record that one or more files were touched ────────────────
export function recordFilesTouched(sessionId, files = [], summary = "") {
  if (!sessionId || !Array.isArray(files) || files.length === 0) return;

  try {
    let workingSet = getWorkingSet(sessionId);
    const now = new Date().toISOString();

    for (const filePath of files) {
      const p = String(filePath || "").trim();
      if (!p) continue;

      const existing = workingSet.find(f => f.path === p);
      if (existing) {
        existing.summary     = summary || existing.summary;
        existing.lastTouched = now;
        existing.touchCount  = (existing.touchCount || 1) + 1;
      } else {
        workingSet.push({ path: p, summary, lastTouched: now, touchCount: 1 });
      }
    }

    // Sort by most-recently-touched first, cap the list
    workingSet.sort((a, b) => new Date(b.lastTouched) - new Date(a.lastTouched));
    workingSet = workingSet.slice(0, MAX_FILES);

    // Upsert: ensure a row exists, then update working_set
    const exists = db.prepare(`SELECT 1 FROM ${TABLE} WHERE session_id = ?`).get(sessionId);
    if (exists) {
      db.prepare(`UPDATE ${TABLE} SET working_set = ? WHERE session_id = ?`)
        .run(JSON.stringify(workingSet), sessionId);
    } else {
      db.prepare(`INSERT INTO ${TABLE} (session_id, working_set) VALUES (?, ?)`)
        .run(sessionId, JSON.stringify(workingSet));
    }

    console.log(`[WorkingSet] ${sessionId}: ${workingSet.length} files tracked (top: ${workingSet[0]?.path})`);
  } catch (err) {
    console.warn("[WorkingSet] recordFilesTouched failed:", err.message);
  }
}

// ── Get the single most-recently-touched file ─────────────────
export function getLastTouchedFile(sessionId) {
  const ws = getWorkingSet(sessionId);
  const candidate = ws[0]?.path || "";
  // Only return real file paths (must contain a slash or a file extension).
  // Rejects junk values like "1.0" that may have leaked from old memory.
  if (candidate && (candidate.includes("/") || /\.[a-z0-9]+$/i.test(candidate))) {
    return candidate;
  }
  return "";
}

// ── Build a context string for the planner / explore node ─────
export function buildWorkingSetContext(sessionId) {
  const ws = getWorkingSet(sessionId);
  if (ws.length === 0) return "";

  const lines = ws.map((f, i) =>
    `  ${i + 1}. ${f.path}${f.summary ? ` — ${f.summary}` : ""} (touched ${f.touchCount}×)`
  );

  return `Recently worked-on files (most recent first):\n${lines.join("\n")}`;
}
