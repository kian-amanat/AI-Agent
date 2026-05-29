import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, 'memory.db');

const db = new Database(DB_PATH);

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
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`);

export function createSession(id, title = null) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, created_at, updated_at, title)
    VALUES (?, ?, ?, ?)
  `).run(id, now, now, title);
}

export function saveMessage(sessionId, role, content, intent = null) {
  const now = new Date().toISOString();
  // update session updated_at
  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, sessionId);
  db.prepare(`
    INSERT INTO messages (session_id, role, content, intent, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, role, content, intent, now);
}

export function getSessionMessages(sessionId, limit = 20) {
  return db.prepare(`
    SELECT role, content, intent, created_at
    FROM messages WHERE session_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(sessionId, limit).reverse();
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
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

export function touchSession(sessionId) {
  db.prepare(`UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(sessionId);
}

export default db;
