/**
 * bench/recorder.mjs
 * Captures everything a run emits, in enough detail to debug it afterwards
 * without re-running it.
 *
 * Three streams, all sequenced against one monotonic counter so they can be
 * interleaved back into a single ordered timeline at replay time:
 *
 *   transcript  — every event the agent emitted (progress, content, usage, todo)
 *   timeline    — every tool call: name, args, status, duration, output
 *   askUser     — every question the agent surfaced to a human
 *
 * The recorder never touches the DB or the agent's session memory. It plugs
 * into the same three injection points the real server uses (emit / recordEvent
 * / askUser), so what it captures is exactly what a real run does.
 */

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_CONTENT_CHARS = 200_000;

function truncate(str, max) {
  const s = String(str ?? "");
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

/**
 * @param {object} opts
 * @param {(q: {question:string,header?:string,options?:any}) => string} [opts.answerQuestion]
 *   How to respond when the agent asks a human something. Defaults to an honest
 *   "no human is here" — a benchmark must never be able to hang waiting on one.
 */
export function createRecorder({ answerQuestion } = {}) {
  const startedAt = Date.now();
  const transcript = [];
  const timeline = [];
  const askUserCalls = [];
  const contentChunks = [];
  let seq = 0;

  const at = () => ({ seq: seq++, tMs: Date.now() - startedAt });

  const emit = (event) => {
    if (!event || typeof event !== "object") return;
    const entry = { ...at(), stream: "emit", type: event.type ?? "unknown" };
    if (event.type === "content") {
      const c = String(event.content ?? "");
      contentChunks.push(c);
      entry.content = truncate(c, 4000);
    } else {
      // Progress/usage/todo/plan_preview events are small and structured —
      // keep them whole; they are most of what makes a replay readable.
      for (const [k, v] of Object.entries(event)) {
        if (k === "type") continue;
        entry[k] = typeof v === "string" ? truncate(v, 4000) : v;
      }
    }
    transcript.push(entry);
  };

  /**
   * The agent's own working-memory hook. In production this persists turn_events;
   * here it feeds the tool timeline instead — so benchmark logs stay entirely
   * separate from live agent memory.
   */
  const recordEvent = (event) => {
    if (!event || typeof event !== "object") return;
    const base = { ...at(), stream: "record", kind: event.kind };
    if (event.kind === "tool") {
      const call = {
        ...base,
        toolCallId: event.toolCallId ?? null,
        toolName: event.toolName ?? "(unknown)",
        args: event.toolArgs ?? {},
        status: event.status ?? "ok",
        durationMs: event.durationMs ?? null,
        output: truncate(event.content, MAX_TOOL_OUTPUT_CHARS),
      };
      timeline.push(call);
      transcript.push({ ...base, toolName: call.toolName, status: call.status, durationMs: call.durationMs });
      return;
    }
    transcript.push({
      ...base,
      content: truncate(event.content, 8000),
      toolCalls: Array.isArray(event.toolCalls)
        ? event.toolCalls.map((t) => ({ name: t?.function?.name ?? null, id: t?.id ?? null }))
        : null,
    });
  };

  const askUser = async (question) => {
    const q = {
      ...at(),
      stream: "ask_user",
      question: String(question?.question ?? ""),
      header: question?.header ?? null,
      options: question?.options ?? null,
    };
    askUserCalls.push(q);
    transcript.push({ ...q });
    const answer = answerQuestion
      ? answerQuestion(question)
      : "(benchmark harness: no human is available to answer — proceed with your best judgment, or stop and report the blocker)";
    q.answer = answer;
    return answer;
  };

  return {
    emit,
    recordEvent,
    askUser,
    transcript,
    timeline,
    askUserCalls,
    /** Everything the agent streamed as prose, reassembled. */
    get streamedContent() {
      return truncate(contentChunks.join(""), MAX_CONTENT_CHARS);
    },
    /** Counts used by scoring — derived here so scoring stays pure. */
    summary() {
      const byTool = {};
      let failedToolCalls = 0;
      for (const c of timeline) {
        byTool[c.toolName] = (byTool[c.toolName] ?? 0) + 1;
        if (c.status === "error") failedToolCalls++;
      }
      return {
        toolCalls: timeline.length,
        failedToolCalls,
        askUserCalls: askUserCalls.length,
        events: transcript.length,
        toolCallsByName: Object.fromEntries(Object.keys(byTool).sort().map((k) => [k, byTool[k]])),
      };
    },
  };
}
