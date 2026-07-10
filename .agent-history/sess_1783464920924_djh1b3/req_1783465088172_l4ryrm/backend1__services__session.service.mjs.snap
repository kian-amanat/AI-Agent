import {
  createSession as dbCreateSession,
  saveMessage as dbSaveMessage,
  getSessionMessages as dbGetSessionMessages,
  listSessions as dbListSessions,
  deleteSession as dbDeleteSession,
  touchSession as dbTouchSession,
  getSessionMemory as dbGetSessionMemory,
  updateSessionMemory as dbUpdateSessionMemory,
  clearSessionMemory as dbClearSessionMemory,
} from "../db.mjs";

export function normalizeSessionLabel(message, attachments = []) {
  const msg = String(message || "").trim();
  if (msg) return msg.slice(0, 60);

  if (attachments.length) {
    const names = attachments
      .slice(0, 3)
      .map((a) => a.originalName)
      .filter(Boolean);

    if (names.length) return `Attachments: ${names.join(", ")}`.slice(0, 60);
  }

  return "New session";
}

export function createSession(id, userId, title = null) {
  return dbCreateSession(id, userId, title);
}

export function saveMessage(sessionId, userId, role, content, intent = null, requestId = null, fileDiffs = null) {
  return dbSaveMessage(sessionId, userId, role, content, intent, requestId, fileDiffs);
}

export function getSessionMessages(sessionId, userId, limit = 20) {
  return dbGetSessionMessages(sessionId, userId, limit);
}

export function listSessions(userId, limit = 50) {
  return dbListSessions(userId, limit);
}

export function deleteSession(sessionId, userId) {
  if (!sessionId || !userId) throw new Error('Invalid session ID or user ID');
  return dbDeleteSession(sessionId, userId);
}

export function touchSession(sessionId, userId) {
  return dbTouchSession(sessionId, userId);
}

export function getSessionMemory(sessionId, userId) {
  return dbGetSessionMemory(sessionId, userId);
}

export function updateSessionMemory(sessionId, userId, patch = {}) {
  return dbUpdateSessionMemory(sessionId, userId, patch);
}

export function clearSessionMemory(sessionId, userId) {
  return dbClearSessionMemory(sessionId, userId);
}