import {
  createSession as dbCreateSession,
  saveMessage as dbSaveMessage,
  getSessionMessages as dbGetSessionMessages,
  listSessions as dbListSessions,
  deleteSession as dbDeleteSession,
  touchSession as dbTouchSession,
} from "../db.mjs";

export function normalizeSessionLabel(message, attachments = []) {
  const msg = String(message || "").trim();
  if (msg) return msg.slice(0, 60);

  if (attachments.length) {
    const names = attachments.slice(0, 3).map((a) => a.originalName).filter(Boolean);
    if (names.length) return `Attachments: ${names.join(", ")}`.slice(0, 60);
  }

  return "New session";
}

export const createSession = dbCreateSession;
export const saveMessage = dbSaveMessage;
export const getSessionMessages = dbGetSessionMessages;
export const listSessions = dbListSessions;
export const deleteSession = dbDeleteSession;
export const touchSession = dbTouchSession;