/**
 * services/interactionManager.mjs
 *
 * Runtime manager for PENDING USER INTERACTIONS — requests that originate
 * inside the runtime and can only be resolved by a human.
 *
 * Built for MCP elicitation (a server asking Kodo to obtain information or
 * confirmation from the user), but deliberately generic: it knows nothing about
 * MCP, HTTP, SSE, or any front-end. A caller creates an interaction and awaits
 * a promise; some transport surfaces it and later calls respond()/cancel().
 * That decoupling is what keeps the runtime testable without a UI.
 *
 * NON-NEGOTIABLE: nothing here ever answers on the user's behalf. There is no
 * auto-accept path. A timeout resolves as "cancel", never as "accept" — a
 * silent approval would defeat the entire point of asking.
 */

import crypto from "crypto";
import { EventEmitter } from "events";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Bounded so a misbehaving server cannot exhaust memory by opening interactions.
const MAX_PENDING_PER_SESSION = 20;

export const INTERACTION_ACCEPT = "accept";
export const INTERACTION_DECLINE = "decline";
export const INTERACTION_CANCEL = "cancel";

export class InteractionManager extends EventEmitter {
  constructor({ defaultTimeoutMs = DEFAULT_TIMEOUT_MS, maxPerSession = MAX_PENDING_PER_SESSION } = {}) {
    super();
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxPerSession = maxPerSession;
    this.pending = new Map(); // id → record
  }

  /**
   * Open an interaction. Returns { id, promise }; the promise settles with
   * { action, content } once someone responds, the caller cancels, or the
   * timeout expires.
   *
   * `emit("pending", …)` is how a transport learns it should ask the user. If
   * nothing is listening, the interaction still exists and still times out —
   * it simply goes unanswered, which is the correct, safe outcome.
   */
  create({ sessionId = "default", kind = "elicitation", message = "", schema = null, source = null, timeoutMs, signal = null } = {}) {
    const openForSession = [...this.pending.values()].filter((r) => r.sessionId === sessionId).length;
    if (openForSession >= this.maxPerSession) {
      return {
        id: null,
        promise: Promise.resolve({ action: INTERACTION_CANCEL, reason: "too many pending interactions for this session" }),
      };
    }

    const id = `int_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.defaultTimeoutMs;

    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });

    const finish = (outcome) => {
      const record = this.pending.get(id);
      if (!record) return false;           // already settled — replay-safe
      this.pending.delete(id);
      clearTimeout(record.timer);
      record.detachAbort?.();
      this.emit("settled", { id, sessionId, ...outcome });
      settle(outcome);
      return true;
    };

    // Deliberately NOT unref'd: a pending interaction is outstanding work — an
    // MCP server is blocked waiting on it. Letting the process exit underneath
    // would strand that request with no reply at all.
    const timer = setTimeout(
      () => finish({ action: INTERACTION_CANCEL, reason: `timed out after ${Math.round(ms / 1000)}s with no response` }),
      ms,
    );

    // Register BEFORE wiring the abort listener: finish() resolves by looking
    // the record up, so an ALREADY-aborted signal would otherwise fire against
    // an empty map and leave the promise permanently unsettled.
    const record = { id, sessionId, kind, message, schema, source, createdAt: Date.now(), timer, finish, detachAbort: null };
    this.pending.set(id, record);

    // An aborted run must not leave the server waiting forever.
    if (signal) {
      const onAbort = () => finish({ action: INTERACTION_CANCEL, reason: "run aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      record.detachAbort = () => signal.removeEventListener?.("abort", onAbort);
      if (signal.aborted) onAbort();
    }

    // Only announce an interaction that is still live — an already-aborted one
    // is settled by now and must not be surfaced as something to answer.
    if (this.pending.has(id)) {
      this.emit("pending", { id, sessionId, kind, message, schema, source, timeoutMs: ms });
    }

    return { id, promise };
  }

  /**
   * Deliver a user's answer. Returns false for an unknown or already-settled id
   * so a duplicate submit is a no-op rather than a crash or a double-answer.
   */
  respond(id, { action = INTERACTION_ACCEPT, content = null, reason = "" } = {}) {
    const record = this.pending.get(id);
    if (!record) return false;
    const normalized = [INTERACTION_ACCEPT, INTERACTION_DECLINE, INTERACTION_CANCEL].includes(action)
      ? action
      : INTERACTION_DECLINE; // an unrecognised action must never read as acceptance
    return record.finish({ action: normalized, content: normalized === INTERACTION_ACCEPT ? content : null, reason });
  }

  cancel(id, reason = "cancelled") {
    const record = this.pending.get(id);
    if (!record) return false;
    return record.finish({ action: INTERACTION_CANCEL, reason });
  }

  cancelSession(sessionId, reason = "session ended") {
    let n = 0;
    for (const record of [...this.pending.values()]) {
      if (record.sessionId === sessionId && record.finish({ action: INTERACTION_CANCEL, reason })) n++;
    }
    return n;
  }

  get(id) {
    const r = this.pending.get(id);
    if (!r) return null;
    // Never expose internals (timers, resolvers) to callers/transports.
    return { id: r.id, sessionId: r.sessionId, kind: r.kind, message: r.message, schema: r.schema, source: r.source, createdAt: r.createdAt };
  }

  listPending(sessionId = null) {
    return [...this.pending.values()]
      .filter((r) => !sessionId || r.sessionId === sessionId)
      .map((r) => this.get(r.id));
  }

  get size() { return this.pending.size; }

  // Test/shutdown helper — settles everything as cancelled.
  disposeAll(reason = "shutdown") {
    let n = 0;
    for (const record of [...this.pending.values()]) if (record.finish({ action: INTERACTION_CANCEL, reason })) n++;
    return n;
  }
}

// Process-wide default, so the MCP layer and the HTTP route share one registry.
export const interactions = new InteractionManager();
