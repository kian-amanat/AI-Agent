/**
 * services/conversationStore.mjs
 *
 * Rebuilds the agent's tool-loop conversation from persisted turn_events so a
 * new turn continues the previous one instead of restarting from a summary.
 *
 * The loop's live conversation is an OpenAI-style array:
 *   { role:"user",      content }
 *   { role:"assistant", content, tool_calls:[…] }
 *   { role:"tool",      tool_call_id, content }
 * turn_events stores exactly those shapes, so replay is a direct map — the
 * model sees the real execution history (what it read, what it edited, what
 * failed) rather than a lossy digest of it.
 *
 * Two invariants make that safe to feed back to a provider:
 *  1. PAIRING — every assistant tool_call must be followed by a tool result
 *     with the same id. A truncated tail (or a run killed mid-flight) would
 *     otherwise leave a dangling call and the request 400s. Unmatched calls
 *     are repaired, never emitted raw.
 *  2. BUDGET — history is compacted by VALUE, not by age alone: pinned rows
 *     and recent turns stay verbatim, older tool payloads degrade to a
 *     one-line receipt ("read_file(a.ts) → ok"), and only then do the oldest
 *     rows collapse into a digest. The fact a tool ran is never dropped.
 */

const RECENT_VERBATIM_EVENTS = 40;   // newest events kept exactly as recorded
const DEFAULT_CHAR_BUDGET = 60_000;  // replayed history only; the live loop has its own budget
const RECEIPT_CONTENT_MAX = 200;     // compressed tool payload
const DIGEST_MAX = 1_200;

function parseJSON(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function firstLine(text, max = RECEIPT_CONTENT_MAX) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// A tool result compressed to its receipt: which tool, on what, and whether it
// worked. Keeps "I already read auth.ts and it uses JWT" discoverable without
// carrying the whole file back into context.
function toolReceipt(event) {
  const args = parseJSON(event.tool_args) ?? event.tool_args;
  let target = "";
  if (args && typeof args === "object") {
    target = args.path || args.pattern || args.command || args.url || args.query || "";
  } else if (typeof args === "string") {
    target = args;
  }
  const head = `${event.tool_name || "tool"}(${firstLine(target, 80)})`;
  const status = event.status === "error" ? "✗ failed" : "✓";
  const detail = firstLine(event.content, RECEIPT_CONTENT_MAX);
  return `${head} → ${status}${detail ? ` ${detail}` : ""}`;
}

function eventChars(m) {
  let n = String(m.content ?? "").length;
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) n += (tc.function?.arguments?.length || 0) + 40;
  }
  return n;
}

/**
 * Map raw turn_events rows to conversation messages.
 * `compress` swaps tool payloads for receipts while keeping the message shape
 * (and therefore tool_call pairing) intact.
 */
function toMessage(event, { compress = false } = {}) {
  if (event.kind === "user") {
    return { role: "user", content: String(event.content ?? "") };
  }
  if (event.kind === "assistant") {
    const toolCalls = parseJSON(event.tool_calls);
    const msg = { role: "assistant", content: String(event.content ?? "") };
    if (Array.isArray(toolCalls) && toolCalls.length) msg.tool_calls = toolCalls;
    return msg;
  }
  if (event.kind === "tool") {
    return {
      role: "tool",
      tool_call_id: event.tool_call_id || "",
      content: compress ? toolReceipt(event) : String(event.content ?? ""),
    };
  }
  return null;
}

/**
 * Drop assistant tool_calls that have no matching tool result, and drop tool
 * results whose call isn't present. Compaction and truncation can both sever a
 * pair; an unpaired call is a hard provider error, so this runs last and is the
 * single place that guarantees the array is well-formed.
 */
export function repairToolPairing(messages) {
  const resultIds = new Set(
    messages.filter((m) => m.role === "tool" && m.tool_call_id).map((m) => m.tool_call_id),
  );

  const out = [];
  const keptCallIds = new Set();

  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const kept = m.tool_calls.filter((tc) => resultIds.has(tc.id));
      const dropped = m.tool_calls.length - kept.length;
      const next = { ...m };

      if (kept.length) {
        next.tool_calls = kept;
        for (const tc of kept) keptCallIds.add(tc.id);
      } else {
        delete next.tool_calls;
      }
      // Never silently lose the fact that work happened — if a call's result
      // didn't survive, say so in text rather than dropping it without trace.
      if (dropped > 0) {
        const names = m.tool_calls.filter((tc) => !resultIds.has(tc.id))
          .map((tc) => tc.function?.name || "tool").join(", ");
        const note = `[earlier: ran ${names} — result no longer in context]`;
        next.content = next.content ? `${next.content}\n${note}` : note;
      }
      // An assistant row with neither text nor calls is not a valid message.
      if (!next.tool_calls && !String(next.content || "").trim()) continue;
      out.push(next);
      continue;
    }

    if (m.role === "tool") {
      if (!keptCallIds.has(m.tool_call_id)) continue; // orphaned result
      out.push(m);
      continue;
    }

    out.push(m);
  }

  return out;
}

/**
 * Build the replayable prior conversation for a new turn.
 *
 * Compaction order (lowest value degraded first), per the priority the loop
 * actually depends on:
 *   1. pinned rows + the most recent `recentVerbatim` events — untouched
 *   2. older tool payloads  → one-line receipts (the call is still visible)
 *   3. still over budget    → oldest rows collapse into a single digest line
 *
 * Returns [] for an empty/uninitialised session so a first turn is unchanged.
 */
export function buildConversationFromEvents(events, {
  charBudget = DEFAULT_CHAR_BUDGET,
  recentVerbatim = RECENT_VERBATIM_EVENTS,
} = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];

  // A trailing user row means that turn never produced an answer (aborted or
  // crashed). Replaying it invites the model to resume an abandoned task
  // instead of doing what was just asked.
  const rows = events.slice();
  while (rows.length && rows[rows.length - 1].kind === "user") rows.pop();
  if (!rows.length) return [];

  const cutoff = Math.max(0, rows.length - recentVerbatim);
  let entries = rows
    .map((e, i) => {
      const compress = i < cutoff && !e.pinned && e.kind === "tool";
      const msg = toMessage(e, { compress });
      return msg ? { msg, pinned: !!e.pinned } : null;
    })
    .filter(Boolean);

  // Still too big: collapse the oldest UNPINNED stretch into one digest line,
  // preserving WHAT happened (tool names, decisions) even as detail is lost.
  // Pinned rows survive every compaction cycle by contract, so they are lifted
  // out of the collapsed range rather than folded into the digest.
  const total = entries.reduce((n, e) => n + eventChars(e.msg), 0);
  if (total > charBudget) {
    const keepTail = Math.max(recentVerbatim, Math.ceil(entries.length / 4));
    const headCount = Math.max(0, entries.length - keepTail);

    if (headCount > 0) {
      const head = entries.slice(0, headCount);
      const survivors = head.filter((e) => e.pinned);
      const digest = head
        .filter((e) => !e.pinned)
        .map(({ msg }) => {
          if (msg.role === "assistant" && msg.tool_calls?.length) {
            return msg.tool_calls.map((tc) => tc.function?.name).filter(Boolean).join(", ");
          }
          if (msg.role === "tool") return null;
          return firstLine(msg.content, 100);
        })
        .filter(Boolean)
        .join(" | ");

      entries = [
        ...(digest
          ? [{ msg: { role: "user", content: `[Earlier in this session: ${firstLine(digest, DIGEST_MAX)}]` }, pinned: false }]
          : []),
        ...survivors,
        ...entries.slice(headCount),
      ];
    }
  }

  const repaired = repairToolPairing(entries.map((e) => e.msg));

  // Pairing repair drops orphaned tool results — correct in general, but it
  // would silently defeat a PIN whose parent assistant call was collapsed into
  // the digest. Re-attach anything pinned that was lost, as plain text (a
  // provider-legal shape that needs no matching call), so "pinned survives
  // every compaction cycle" holds unconditionally.
  const survivingToolIds = new Set(
    repaired.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
  );
  const lostPinned = entries.filter(
    (e) => e.pinned && e.msg.role === "tool" && !survivingToolIds.has(e.msg.tool_call_id),
  );
  if (lostPinned.length) {
    const retained = lostPinned.map((e) => firstLine(e.msg.content, 300)).join(" | ");
    repaired.unshift({ role: "user", content: `[Still in effect from earlier: ${retained}]` });
  }

  return repaired;
}

/**
 * Deduplicate identical read-only observations so a long session doesn't pay
 * for the same file three times. Keeps the LATEST occurrence verbatim (it
 * reflects the current state of the file) and reduces earlier ones to a
 * pointer. Only applied to idempotent read tools — repeated bash/edit calls
 * are meaningful events, not redundancy.
 */
const DEDUPABLE_TOOLS = new Set(["read_file", "grep", "glob", "list_files", "fetch_url"]);

export function dedupeObservations(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const lastIndexByKey = new Map();

  events.forEach((e, i) => {
    if (e.kind !== "tool" || !DEDUPABLE_TOOLS.has(e.tool_name)) return;
    lastIndexByKey.set(`${e.tool_name}::${e.tool_args ?? ""}`, i);
  });

  return events.map((e, i) => {
    if (e.kind !== "tool" || !DEDUPABLE_TOOLS.has(e.tool_name)) return e;
    const key = `${e.tool_name}::${e.tool_args ?? ""}`;
    if (lastIndexByKey.get(key) === i) return e;
    return { ...e, content: `(superseded by a later identical ${e.tool_name} call)` };
  });
}
