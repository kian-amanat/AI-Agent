import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "memory.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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

function columnExists(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((col) => col.name === columnName);
}

function ensureColumn(tableName, columnName, ddlType) {
  if (!columnExists(tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${ddlType}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    UNIQUE NOT NULL,
    password   TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    plan       TEXT    NOT NULL DEFAULT 'free',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id             TEXT    PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token          TEXT    NOT NULL,
    workspace_path TEXT,
    workspace_name TEXT,
    created_at     TEXT    NOT NULL,
    last_active    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_id INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    intent TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_memory (
    session_id TEXT PRIMARY KEY,
    user_id INTEGER,
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
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

ensureColumn("sessions", "user_id", "INTEGER");
ensureColumn("messages", "user_id", "INTEGER");
ensureColumn("messages", "request_id", "TEXT");
ensureColumn("messages", "file_diffs", "TEXT");
ensureColumn("session_memory", "user_id", "INTEGER");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session_user ON messages(session_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_memory_session_user ON session_memory(session_id, user_id);
`);

function normalizeMemoryRow(row) {
  if (!row) return null;

  return {
    session_id: row.session_id,
    user_id: row.user_id ?? null,
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

function ensureMemoryRow(sessionId, userId) {
  const now = nowIso();

  db.prepare(`
    INSERT OR IGNORE INTO session_memory (session_id, user_id, updated_at)
    VALUES (?, ?, ?)
  `).run(sessionId, userId, now);

  const row = db.prepare(`
    SELECT user_id FROM session_memory WHERE session_id = ?
  `).get(sessionId);

  if (row && row.user_id == null) {
    db.prepare(`
      UPDATE session_memory
      SET user_id = ?
      WHERE session_id = ?
    `).run(userId, sessionId);
  }
}

function ensureSessionOwnership(sessionId, userId) {
  const row = db.prepare(`
    SELECT id, user_id FROM sessions WHERE id = ?
  `).get(sessionId);

  if (!row) return;

  if (row.user_id == null) {
    db.prepare(`
      UPDATE sessions
      SET user_id = ?
      WHERE id = ?
    `).run(userId, sessionId);
    return;
  }

  if (Number(row.user_id) !== Number(userId)) {
    throw new Error("Session does not belong to this user");
  }
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

export function createSession(id, userId, title = null) {
  const now = nowIso();

  const existing = db.prepare(`
    SELECT id, user_id FROM sessions WHERE id = ?
  `).get(id);

  if (!existing) {
    db.prepare(`
      INSERT INTO sessions (id, user_id, created_at, updated_at, title)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, now, now, title);
  } else {
    if (existing.user_id == null) {
      db.prepare(`
        UPDATE sessions
        SET user_id = ?, updated_at = ?, title = COALESCE(?, title)
        WHERE id = ?
      `).run(userId, now, title, id);
    } else if (Number(existing.user_id) !== Number(userId)) {
      throw new Error("Session does not belong to this user");
    } else if (title !== null) {
      db.prepare(`
        UPDATE sessions
        SET updated_at = ?, title = COALESCE(?, title)
        WHERE id = ? AND user_id = ?
      `).run(now, title, id, userId);
    } else {
      db.prepare(`
        UPDATE sessions
        SET updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(now, id, userId);
    }
  }

  ensureMemoryRow(id, userId);
}

export function saveMessage(sessionId, userId, role, content, intent = null, requestId = null, fileDiffs = null) {
  const now = nowIso();

  ensureSessionOwnership(sessionId, userId);

  db.prepare(`
    UPDATE sessions
    SET updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, sessionId, userId);

  db.prepare(`
    INSERT INTO messages (session_id, user_id, role, content, intent, created_at, request_id, file_diffs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, userId, role, content, intent, now, requestId ?? null, fileDiffs ? JSON.stringify(fileDiffs) : null);

  ensureMemoryRow(sessionId, userId);

  db.prepare(`
    UPDATE session_memory
    SET
      last_role = ?,
      last_message = ?,
      last_intent = ?,
      updated_at = ?
    WHERE session_id = ? AND user_id = ?
  `).run(role, content, intent, now, sessionId, userId);
}

export function getSessionMessages(sessionId, userId, limit = 20) {
  return db
    .prepare(`
      SELECT id, role, content, intent, created_at, request_id, file_diffs
      FROM messages
      WHERE session_id = ? AND user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(sessionId, userId, limit)
    .reverse();
}

export function listSessions(userId, limit = 50) {
  return db.prepare(`
    SELECT s.id, s.title, s.created_at, s.updated_at,
           COUNT(m.id) as message_count
    FROM sessions s
    LEFT JOIN messages m
      ON m.session_id = s.id AND m.user_id = s.user_id
    WHERE s.user_id = ?
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(userId, limit);
}

export function deleteSession(sessionId, userId) {
  db.prepare(`
    DELETE FROM messages
    WHERE session_id = ? AND user_id = ?
  `).run(sessionId, userId);

  db.prepare(`
    DELETE FROM session_memory
    WHERE session_id = ? AND user_id = ?
  `).run(sessionId, userId);

  db.prepare(`
    DELETE FROM sessions
    WHERE id = ? AND user_id = ?
  `).run(sessionId, userId);
}

export function touchSession(sessionId, userId) {
  const now = nowIso();

  ensureSessionOwnership(sessionId, userId);

  db.prepare(`
    UPDATE sessions
    SET updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, sessionId, userId);

  ensureMemoryRow(sessionId, userId);

  db.prepare(`
    UPDATE session_memory
    SET updated_at = ?
    WHERE session_id = ? AND user_id = ?
  `).run(now, sessionId, userId);
}

export function getSessionMemory(sessionId, userId) {
  const row = db
    .prepare(`SELECT * FROM session_memory WHERE session_id = ? AND user_id = ?`)
    .get(sessionId, userId);

  return normalizeMemoryRow(row);
}

export function updateSessionMemory(sessionId, userId, patch = {}) {
  ensureMemoryRow(sessionId, userId);

  const current = getSessionMemory(sessionId, userId) || {
    session_id: sessionId,
    user_id: userId,
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
    WHERE session_id = ? AND user_id = ?
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
    sessionId,
    userId
  );

  return getSessionMemory(sessionId, userId);
}

export function clearSessionMemory(sessionId, userId) {
  db.prepare(`
    DELETE FROM session_memory
    WHERE session_id = ? AND user_id = ?
  `).run(sessionId, userId);
}

export default db;