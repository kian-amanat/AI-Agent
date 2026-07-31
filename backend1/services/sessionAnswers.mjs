/**
 * services/sessionAnswers.mjs
 *
 * ACTIVE-SESSION answer state for clarifying questions (`ask_user`).
 *
 * This exists to keep three things that were previously blurred strictly apart:
 *
 *   1. session memory        — recall/audit text ("LAST TASK", "LAST ANSWER").
 *                              Informs the model; never decides control flow.
 *   2. prior prompt history  — the replayed turn_events transcript.
 *   3. active elicitation    — THIS module: what the user has actually answered
 *      state                  in the session that is running right now.
 *
 * Only (3) may suppress a question. Memory recalling a similar past topic must
 * never be enough to answer on the user's behalf — that is how a stale
 * "production" answer from last week silently applies to today's deploy.
 *
 * Deliberately in-memory and process-scoped: an answer is valid for the ACTIVE
 * session only. A resumed session after a restart legitimately re-asks, because
 * the runtime can no longer vouch that the user is still the same person making
 * the same choice. Persisting these would defeat the point.
 */

const MAX_ANSWERS_PER_SESSION = 50;

// sessionId → Map<normalizedQuestion, { question, answer, at }>
const sessions = new Map();

// Questions are matched on their semantic text, not byte-for-byte: the model
// rarely re-emits identical whitespace/punctuation for the same intent.
// Deliberately conservative — normalisation only lowercases and collapses
// whitespace/trailing punctuation. It never does fuzzy or semantic matching,
// because a false match would answer a DIFFERENT question on the user's behalf.
export function normalizeQuestion(question) {
  return String(question || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.\s]+$/g, "")
    .trim();
}

export function recordAnsweredQuestion(sessionId, question, answer) {
  if (!sessionId || !question) return null;
  const key = normalizeQuestion(question);
  if (!key) return null;

  let store = sessions.get(sessionId);
  if (!store) { store = new Map(); sessions.set(sessionId, store); }

  // Bound the store; drop the oldest entry rather than growing without limit.
  if (store.size >= MAX_ANSWERS_PER_SESSION && !store.has(key)) {
    store.delete(store.keys().next().value);
  }

  const record = { question: String(question), answer, at: Date.now() };
  store.set(key, record);
  return record;
}

/** The answer the user gave IN THIS SESSION, or null. Never a guess. */
export function getAnsweredQuestion(sessionId, question) {
  if (!sessionId || !question) return null;
  return sessions.get(sessionId)?.get(normalizeQuestion(question)) || null;
}

export function listAnsweredQuestions(sessionId) {
  return [...(sessions.get(sessionId)?.values() || [])];
}

/** Called on SessionEnd — an ended session's answers must not leak forward. */
export function clearSessionAnswers(sessionId) {
  return sessions.delete(sessionId);
}

export function answeredSessionCount() { return sessions.size; }

// Test helper.
export function _resetSessionAnswers() { sessions.clear(); }
