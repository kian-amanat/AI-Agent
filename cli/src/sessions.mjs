/**
 * src/sessions.mjs — CLI session persistence.
 *
 * Why not reuse backend1's SQLite store? Because that store is scoped to a
 * numeric `user_id` with a foreign key into an accounts table, and it lives in
 * the server's working directory (backend1/memory.db). A system-installed CLI
 * has no account, no login, and no fixed cwd — adopting that schema would mean
 * inventing a fake user row per machine and writing into whatever directory the
 * server happened to be launched from.
 *
 * What IS reused is the part that carries the intelligence: the recorded events
 * use the exact row shape backend1's `turn_events` table stores, so
 * `buildConversationFromEvents` — the agent's real working-memory replay, with
 * its tool-call pairing repair and value-based compaction — rebuilds a CLI
 * session identically to a web session. Storage differs; memory semantics do
 * not.
 *
 * One JSON file per session under ~/.kodo/sessions.
 */

import fs from "fs";
import path from "path";
import { ensureDir, readJson, sessionsDir, writeJsonAtomic } from "./paths.mjs";

const MAX_EVENTS = 400;   // matches getTurnEvents' default window
const MAX_CONTENT = 20_000;

export function newSessionId() {
  return `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Short handle shown in `kodo sessions` — the tail of the id, like a git sha. */
export const shortId = (id) => String(id).slice(-6);

const sessionFile = (id) => path.join(sessionsDir(), `${id}.json`);

export function createSession({ id = newSessionId(), workspace = "", title = "" } = {}) {
  const session = {
    id,
    workspace,
    title: title.slice(0, 80),
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: 0,
    events: [],
  };
  save(session);
  return session;
}

export function load(id) {
  // Resolve a short handle to a full id, so `kodo resume a82f` works.
  const direct = readJson(sessionFile(id), null);
  if (direct) return direct;
  const match = list().find((s) => s.id === id || shortId(s.id) === id);
  return match ? readJson(sessionFile(match.id), null) : null;
}

export function save(session) {
  session.updatedAt = new Date().toISOString();
  if (session.events.length > MAX_EVENTS) {
    session.events = session.events.slice(-MAX_EVENTS);
  }
  return writeJsonAtomic(sessionFile(session.id), session);
}

export function remove(id) {
  const session = load(id);
  if (!session) return false;
  try { fs.unlinkSync(sessionFile(session.id)); return true; } catch { return false; }
}

export function list() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * Record one turn event in `turn_events` row shape (snake_case columns), which
 * is what conversationStore.buildConversationFromEvents expects.
 */
export function recordEvent(session, event) {
  if (!event?.kind) return;
  session.events.push({
    id: session.events.length + 1,
    request_id: event.requestId ?? null,
    kind: event.kind,
    content: cap(event.content),
    tool_calls: event.toolCalls ? JSON.stringify(event.toolCalls) : null,
    tool_call_id: event.toolCallId ?? null,
    tool_name: event.toolName ?? null,
    tool_args: cap(event.toolArgs, 4000),
    status: event.status ?? null,
    duration_ms: event.durationMs ?? null,
    pinned: event.pinned ? 1 : 0,
    created_at: new Date().toISOString(),
  });
}

function cap(value, max = MAX_CONTENT) {
  if (value == null) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

/** Rebuild the agent's working memory for this session using core's own replay. */
export async function priorConversation(core, session) {
  if (!session?.events?.length) return [];
  const { buildConversationFromEvents, dedupeObservations } = await core.conversation();
  return buildConversationFromEvents(dedupeObservations(session.events));
}

export function ensureStore() {
  return ensureDir(sessionsDir());
}
