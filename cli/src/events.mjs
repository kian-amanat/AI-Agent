/**
 * src/events.mjs — one agent event vocabulary, two renderings.
 *
 * The agent emits a single stream of events (progress / content / file_diff /
 * todo / usage / question / plan_preview). The CLI, the local server's SSE
 * stream and the web UI all consume THAT stream — this file does not invent a
 * CLI-specific protocol, it only decides how the existing one is displayed.
 *
 * Two renderers:
 *
 *   human — content to stdout (it is the result), everything else to stderr.
 *   json  — one JSON object per line on stdout, nothing else on stdout ever.
 *
 * The split matters: `kodo run "..." --json | jq` has to work, and a spinner
 * frame or a "reading file" notice landing in that pipe would break it.
 */

import { style, log, out } from "./term.mjs";

/**
 * The stable public event names. Internal emitter types are mapped onto these
 * so the wire format does not change every time the agent loop gains a stage.
 */
export const EVENT = {
  SESSION_STARTED:   "session_started",
  AGENT_MESSAGE:     "agent_message",
  AGENT_PROGRESS:    "agent_progress",
  TOOL_STARTED:      "tool_started",
  FILE_CHANGED:      "file_changed",
  TODO_UPDATED:      "todo_updated",
  PLAN_PREVIEW:      "plan_preview",
  PERMISSION_ASKED:  "permission_requested",
  QUESTION_ASKED:    "question_asked",
  USAGE:             "usage",
  AGENT_ERROR:       "agent_error",
  SESSION_COMPLETED: "session_completed",
};

/** Map an internal agent emit to the public event shape, or null to drop it. */
export function toPublicEvent(e) {
  if (!e || typeof e !== "object") return null;
  switch (e.type) {
    case "content":
      return { type: EVENT.AGENT_MESSAGE, text: String(e.content ?? "") };
    case "progress":
      return { type: EVENT.AGENT_PROGRESS, stage: e.stage || "", message: e.message || "" };
    case "file_diff":
      return {
        type: EVENT.FILE_CHANGED,
        action: e.action || "edit",
        path: e.path || "",
        language: e.language || "",
        hunks: Array.isArray(e.hunks) ? e.hunks.length : 0,
      };
    case "todo":
      return { type: EVENT.TODO_UPDATED, todos: e.todos || [] };
    case "plan_preview":
      return { type: EVENT.PLAN_PREVIEW, plan: e.plan ?? e.content ?? "" };
    case "question":
      return { type: EVENT.QUESTION_ASKED, questionId: e.questionId, question: e.question, options: e.options || [] };
    case "usage":
      return { type: EVENT.USAGE, usage: e.usage ?? e };
    case "error":
      return { type: EVENT.AGENT_ERROR, error: e.error || "", details: e.details || "" };
    default:
      return null;
  }
}

/** JSON Lines renderer. stdout only, one object per line, no decoration. */
export function jsonRenderer() {
  return {
    emit(internalEvent) {
      const pub = toPublicEvent(internalEvent);
      if (pub) out(JSON.stringify(pub));
    },
    event(pub) { out(JSON.stringify(pub)); },
    finish() {},
  };
}

const STAGE_ICON = {
  exploring: "🔍",
  planning:  "📋",
  executing: "⚙️",
};

/**
 * Human renderer.
 *
 * Assistant prose streams to stdout as it arrives, so a long run reads like a
 * conversation instead of dumping at the end. Tool activity goes to stderr as
 * dimmed one-liners — visible while you watch, invisible when you redirect.
 */
export function humanRenderer({ quiet = false } = {}) {
  let wroteContent = false;

  return {
    emit(e) {
      if (!e || typeof e !== "object") return;

      if (e.type === "content") {
        const text = String(e.content ?? "");
        if (!text) return;
        wroteContent = true;
        process.stdout.write(text);
        return;
      }
      if (quiet) return;

      if (e.type === "progress") {
        const icon = STAGE_ICON[e.stage] || "·";
        // The agent already prefixes many of its own messages with an emoji;
        // don't stack a second one on top.
        const msg = String(e.message || "");
        const prefix = /^\p{Extended_Pictographic}/u.test(msg) ? "" : `${icon} `;
        log(style.gray(`  ${prefix}${msg}`));
        return;
      }
      if (e.type === "file_diff") {
        const verb = e.action === "create" ? "created" : e.action === "delete" ? "deleted" : "edited";
        log(`  ${style.green("●")} ${verb} ${style.bold(e.path || "")}`);
        return;
      }
      if (e.type === "todo" && Array.isArray(e.todos)) {
        for (const t of e.todos) {
          const mark = t.status === "completed" ? style.green("✔")
            : t.status === "in_progress" ? style.yellow("▸")
            : style.gray("○");
          log(`  ${mark} ${style.dim(t.content || t.title || "")}`);
        }
        return;
      }
      if (e.type === "error") {
        log(`${style.red("error")} ${e.error || ""}${e.details ? ` — ${e.details}` : ""}`);
      }
    },
    event() { /* lifecycle events are the CLI's own narration in human mode */ },
    finish() {
      // Streamed prose rarely ends in a newline; without this the shell prompt
      // comes back glued to the last word of the answer.
      if (wroteContent) process.stdout.write("\n");
    },
  };
}
