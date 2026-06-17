import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "memory.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    intent TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_memory (
    session_id TEXT PRIMARY KEY,
    last_role TEXT,
    last_message TEXT,
    last_intent TEXT,
    last_target_file TEXT,
    last_target_files TEXT,
    last_task TEXT,
    last_attachment_paths TEXT,
    last_file_analysis TEXT,
    last_context_json TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function toJsonText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJsonText(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeMemoryRow(row) {
  if (!row) {
    return null;
  }

  return {
    session_id: row.session_id,
    last_role: row.last_role || null,
    last_message: row.last_message || null,
    last_intent: row.last_intent || null,
    last_target_file: row.last_target_file || null,
    last_target_files: parseJsonText(row.last_target_files, []),
    last_task: row.last_task || null,
    last_attachment_paths: parseJsonText(row.last_attachment_paths, []),
    last_file_analysis: row.last_file_analysis || null,
    last_context_json: parseJsonText(row.last_context_json, null),
    updated_at: row.updated_at || null,
  };
}

function ensureMemoryRow(sessionId) {
  const now = nowIso();

  db.prepare(`
    INSERT OR IGNORE INTO session_memory (session_id, updated_at)
    VALUES (?, ?)
  `).run(sessionId, now);
}

function buildMemoryUpdate(existing, patch = {}) {
  const next = { ...existing };

  const keys = [
    "last_role",
    "last_message",
    "last_intent",
    "last_target_file",
    "last_target_files",
    "last_task",
    "last_attachment_paths",
    "last_file_analysis",
    "last_context_json",
  ];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      next[key] = patch[key];
    }
  }

  return next;
}

function serializeMemoryValue(key, value) {
  if (
    key === "last_target_files" ||
    key === "last_attachment_paths" ||
    key === "last_context_json"
  ) {
    return toJsonText(value);
  }

  if (value === undefined) return null;
  if (value === null) return null;
  return String(value);
}

export function createSession(id, title = null) {
  const now = nowIso();

  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, created_at, updated_at, title)
    VALUES (?, ?, ?, ?)
  `).run(id, now, now, title);

  ensureMemoryRow(id);
}

export function saveMessage(sessionId, role, content, intent = null) {
  const now = nowIso();

  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(
    now,
    sessionId
  );

  db.prepare(`
    INSERT INTO messages (session_id, role, content, intent, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, role, content, intent, now);

  ensureMemoryRow(sessionId);

  db.prepare(`
    UPDATE session_memory
    SET
      last_role = ?,
      last_message = ?,
      last_intent = ?,
      updated_at = ?
    WHERE session_id = ?
  `).run(role, content, intent, now, sessionId);
}

export function getSessionMessages(sessionId, limit = 20) {
  return db
    .prepare(`
      SELECT role, content, intent, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(sessionId, limit)
    .reverse();
}

export function listSessions(limit = 50) {
  return db.prepare(`
    SELECT s.id, s.title, s.created_at, s.updated_at,
           COUNT(m.id) as message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(limit);
}

export function deleteSession(sessionId) {
  db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM session_memory WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

export function touchSession(sessionId) {
  const now = nowIso();

  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(
    now,
    sessionId
  );

  ensureMemoryRow(sessionId);

  db.prepare(`UPDATE session_memory SET updated_at = ? WHERE session_id = ?`).run(
    now,
    sessionId
  );
}

export function getSessionMemory(sessionId) {
  const row = db
    .prepare(`SELECT * FROM session_memory WHERE session_id = ?`)
    .get(sessionId);

  return normalizeMemoryRow(row);
}

export function updateSessionMemory(sessionId, patch = {}) {
  ensureMemoryRow(sessionId);

  const current = getSessionMemory(sessionId) || {
    session_id: sessionId,
    last_role: null,
    last_message: null,
    last_intent: null,
    last_target_file: null,
    last_target_files: [],
    last_task: null,
    last_attachment_paths: [],
    last_file_analysis: null,
    last_context_json: null,
    updated_at: nowIso(),
  };

  const next = buildMemoryUpdate(current, patch);
  const now = nowIso();

  db.prepare(`
    UPDATE session_memory
    SET
      last_role = ?,
      last_message = ?,
      last_intent = ?,
      last_target_file = ?,
      last_target_files = ?,
      last_task = ?,
      last_attachment_paths = ?,
      last_file_analysis = ?,
      last_context_json = ?,
      updated_at = ?
    WHERE session_id = ?
  `).run(
    serializeMemoryValue("last_role", next.last_role),
    serializeMemoryValue("last_message", next.last_message),
    serializeMemoryValue("last_intent", next.last_intent),
    serializeMemoryValue("last_target_file", next.last_target_file),
    serializeMemoryValue("last_target_files", next.last_target_files),
    serializeMemoryValue("last_task", next.last_task),
    serializeMemoryValue("last_attachment_paths", next.last_attachment_paths),
    serializeMemoryValue("last_file_analysis", next.last_file_analysis),
    serializeMemoryValue("last_context_json", next.last_context_json),
    now,
    sessionId
  );

  return getSessionMemory(sessionId);
}

export function clearSessionMemory(sessionId) {
  db.prepare(`DELETE FROM session_memory WHERE session_id = ?`).run(sessionId);
}

export default db;