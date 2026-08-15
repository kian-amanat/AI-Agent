import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// KODO_DB_PATH lets a caller point the database somewhere else. Tests need it
// to be hermetic: without it every run shares backend1/memory.db, so a test
// that signs a user up passes once and then fails on "Email already
// registered" — and worse, leaves real rows behind in the developer's database.
const DB_PATH = process.env.KODO_DB_PATH
  ? path.resolve(process.env.KODO_DB_PATH)
  : path.resolve(__dirname, "memory.db");

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

  -- Per-user model/API-key configuration. Replaces the single global
  -- data/settings.json so multiple users can each use their own provider,
  -- model, and key at the same time (true multi-user).
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  -- Background agent runs, decoupled from the HTTP request that started them
  -- so a task keeps running across page refresh / session switch. The live
  -- event stream lives in memory (services/jobs.mjs); this table is the
  -- durable record used to DISCOVER running jobs after a refresh and to detect
  -- jobs orphaned by a server restart.
  CREATE TABLE IF NOT EXISTS agent_jobs (
    request_id   TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    user_id      INTEGER NOT NULL,
    status       TEXT NOT NULL,           -- running | done | error | cancelled | interrupted
    title        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- The agent's WORKING memory, distinct from the messages table (which is the
  -- user-facing chat log). One row per entry in the tool-loop conversation, in
  -- execution order, so a later turn can replay what was actually attempted —
  -- tool calls, their results, failures and all — instead of re-deriving it
  -- from a summary. This is what makes the loop continuous across turns and
  -- recoverable after a restart. Replayed/compacted by
  -- services/conversationStore.mjs.
  CREATE TABLE IF NOT EXISTS turn_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    user_id      INTEGER,
    request_id   TEXT,
    kind         TEXT NOT NULL,           -- user | assistant | tool
    content      TEXT,                    -- message text, or the tool's result payload
    tool_calls   TEXT,                    -- assistant rows: JSON array, verbatim from the model
    tool_call_id TEXT,                    -- tool rows: links back to the assistant's call
    tool_name    TEXT,
    tool_args    TEXT,                    -- JSON string, truncated
    status       TEXT,                    -- tool rows: ok | error
    duration_ms  INTEGER,
    pinned       INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`);

ensureColumn("sessions", "user_id", "INTEGER");
ensureColumn("messages", "user_id", "INTEGER");
ensureColumn("messages", "request_id", "TEXT");
ensureColumn("messages", "file_diffs", "TEXT");
ensureColumn("messages", "attachments", "TEXT");   // JSON: uploaded file chips for a user message
ensureColumn("session_memory", "user_id", "INTEGER");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session_user ON messages(session_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_memory_session_user ON session_memory(session_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_user ON agent_jobs(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_session ON agent_jobs(session_id);
  CREATE INDEX IF NOT EXISTS idx_turn_events_session ON turn_events(session_id, user_id, id);
`);

// A server restart wipes the in-memory job registry, so any job still marked
// "running" in the DB from a previous process can never resume — mark those
// interrupted on boot so the UI shows an honest state instead of a spinner
// that will never resolve.
db.prepare(`UPDATE agent_jobs SET status = 'interrupted', updated_at = ? WHERE status = 'running'`)
  .run(nowIso());

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

export function saveMessage(sessionId, userId, role, content, intent = null, requestId = null, fileDiffs = null, attachments = null) {
  const now = nowIso();

  ensureSessionOwnership(sessionId, userId);

  db.prepare(`
    UPDATE sessions
    SET updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, sessionId, userId);

  db.prepare(`
    INSERT INTO messages (session_id, user_id, role, content, intent, created_at, request_id, file_diffs, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, userId, role, content, intent, now, requestId ?? null, fileDiffs ? JSON.stringify(fileDiffs) : null, attachments ? JSON.stringify(attachments) : null);

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

// Does this session already exist for this user? Distinguishes a NEW session
// from a RESUMED one — createSession is upsert-style, so the answer must be
// read before it runs.
export function sessionExists(sessionId, userId) {
  if (!sessionId) return false;
  const row = db.prepare(`SELECT id FROM sessions WHERE id = ? AND user_id IS ?`)
    .get(sessionId, userId ?? null);
  return !!row;
}

export function getSessionMessages(sessionId, userId, limit = 20) {
  return db
    .prepare(`
      SELECT id, role, content, intent, created_at, request_id, file_diffs, attachments
      FROM messages
      WHERE session_id = ? AND user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(sessionId, userId, limit)
    .reverse();
}

// ── Turn events (the agent's replayable working memory) ──────────────────────
// Persisted per tool-loop entry so a later turn — or a resumed session after a
// restart — can rebuild the real execution history. Oversized payloads are
// capped here rather than at read time: the FACT that a tool ran (and whether
// it failed) matters more than its full output, and storing megabytes of file
// dumps would bloat the DB for no replay benefit.
const TURN_EVENT_CONTENT_MAX = 4_000;
const TURN_EVENT_ARGS_MAX = 2_000;

function capText(value, max) {
  if (value == null) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s == null) return null;
  return s.length > max ? `${s.slice(0, max)} …[truncated]` : s;
}

export function appendTurnEvent({
  sessionId, userId, requestId = null, kind, content = null,
  toolCalls = null, toolCallId = null, toolName = null, toolArgs = null,
  status = null, durationMs = null, pinned = false,
}) {
  if (!sessionId || !kind) return;
  db.prepare(`
    INSERT INTO turn_events
      (session_id, user_id, request_id, kind, content, tool_calls, tool_call_id,
       tool_name, tool_args, status, duration_ms, pinned, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, userId ?? null, requestId, kind,
    capText(content, TURN_EVENT_CONTENT_MAX),
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolCallId, toolName,
    capText(toolArgs, TURN_EVENT_ARGS_MAX),
    status, durationMs, pinned ? 1 : 0, nowIso(),
  );
}

// Newest `limit` events, returned oldest-first so the caller can replay them
// directly into a conversation array.
export function getTurnEvents(sessionId, userId, limit = 400) {
  return db.prepare(`
    SELECT id, request_id, kind, content, tool_calls, tool_call_id,
           tool_name, tool_args, status, duration_ms, pinned, created_at
    FROM turn_events
    WHERE session_id = ? AND user_id IS ?
    ORDER BY id DESC
    LIMIT ?
  `).all(sessionId, userId ?? null, limit).reverse();
}

export function clearTurnEvents(sessionId, userId) {
  return db.prepare(`DELETE FROM turn_events WHERE session_id = ? AND user_id IS ?`)
    .run(sessionId, userId ?? null);
}

// Keep a session's working memory bounded over a long-lived session: drop the
// oldest unpinned rows once the table grows past `keep` for this session.
export function pruneTurnEvents(sessionId, userId, keep = 600) {
  return db.prepare(`
    DELETE FROM turn_events
    WHERE session_id = ? AND user_id IS ? AND pinned = 0 AND id NOT IN (
      SELECT id FROM turn_events
      WHERE session_id = ? AND user_id IS ?
      ORDER BY id DESC LIMIT ?
    )
  `).run(sessionId, userId ?? null, sessionId, userId ?? null, keep);
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
    DELETE FROM turn_events
    WHERE session_id = ? AND user_id IS ?
  `).run(sessionId, userId ?? null);

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

// ── Per-user settings ─────────────────────────────────────────────────────────

export function getUserSettings(userId) {
  if (!userId) return null;
  const row = db.prepare(`SELECT settings_json FROM user_settings WHERE user_id = ?`).get(userId);
  if (!row) return null;
  return parseJsonText(row.settings_json, null);
}

export function saveUserSettings(userId, settings) {
  if (!userId) throw new Error("userId is required to save settings");
  const now = nowIso();
  const json = JSON.stringify(settings ?? {});
  db.prepare(`
    INSERT INTO user_settings (user_id, settings_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
  `).run(userId, json, now);
  return settings;
}

export function userHasSettings(userId) {
  if (!userId) return false;
  return !!db.prepare(`SELECT 1 FROM user_settings WHERE user_id = ?`).get(userId);
}

// ── Agent jobs (durable discovery record for background runs) ─────────────────

export function createAgentJob({ requestId, sessionId, userId, title }) {
  const now = nowIso();
  db.prepare(`
    INSERT OR REPLACE INTO agent_jobs (request_id, session_id, user_id, status, title, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?)
  `).run(requestId, sessionId, userId, title ?? null, now, now);
}

export function updateAgentJobStatus(requestId, status) {
  db.prepare(`UPDATE agent_jobs SET status = ?, updated_at = ? WHERE request_id = ?`)
    .run(status, nowIso(), requestId);
}

export function listActiveAgentJobs(userId, sessionId = null) {
  if (sessionId) {
    return db.prepare(`
      SELECT request_id, session_id, status, title, created_at, updated_at
      FROM agent_jobs
      WHERE user_id = ? AND session_id = ? AND status = 'running'
      ORDER BY created_at DESC
    `).all(userId, sessionId);
  }
  return db.prepare(`
    SELECT request_id, session_id, status, title, created_at, updated_at
    FROM agent_jobs
    WHERE user_id = ? AND status = 'running'
    ORDER BY created_at DESC
  `).all(userId);
}

export function getAgentJob(requestId, userId) {
  return db.prepare(`
    SELECT request_id, session_id, user_id, status, title, created_at, updated_at
    FROM agent_jobs
    WHERE request_id = ? AND user_id = ?
  `).get(requestId, userId) || null;
}

export default db;