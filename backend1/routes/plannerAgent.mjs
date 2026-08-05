/**
 * routes/plannerAgent.mjs  — UPDATED for LangGraph + Memory (Tier 1+2)
 */

import { promises as fs, createReadStream, createWriteStream } from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";

import {
  createSession,
  saveMessage,
  getSessionMessages,
  listSessions,
  deleteSession,
  touchSession,
  normalizeSessionLabel,
} from "../services/session.service.mjs";
import {
  getMemory,
  rememberTask,
  rememberFiles,
  rememberUserMessage,
  rememberAssistantMessage,
  rememberTargetFile,
} from "../services/memory.service.mjs";
import { parseIncomingPayload }        from "../utils/request.util.mjs";
import { isImageMime, inferMimeTypeFromPath } from "../utils/path.util.mjs";
import { loadAttachmentsFromPaths, buildAttachmentContext } from "../services/attachments.service.mjs";
import { detectLanguage }              from "../services/intent.service.mjs";
import { streamPlanSummary }           from "../services/response.service.mjs";
import { PLANS_DIR, OPENAI_API_KEY, OPENAI_BASE_URL, WHISPER_MODEL, openai } from "../config/openai.mjs";
import { uniq }                        from "../utils/text.util.mjs";
import { undoRequestChanges }          from "../services/undo.service.mjs";
import { routeModel, getCapabilities } from "../services/modelRouter.mjs";
import { loadUserSettings } from "../services/userSettings.service.mjs";
import db, {
  createAgentJob,
  updateAgentJobStatus,
  getAgentJob,
  appendTurnEvent,
  getTurnEvents,
  pruneTurnEvents,
  sessionExists,
} from "../db.mjs";
import { createHookRunner } from "../services/hooks.mjs";
import {
  ensureSetup, ensureSessionStart, endSession, attachRunner,
} from "../services/sessionHooks.mjs";
import { acquireConfigWatcher } from "../services/configWatcher.mjs";
import {
  collectProjectEvidence, evidenceFooter, generateValidatedKodoMd,
} from "../services/projectEvidence.mjs";
import {
  loadCommandRegistry, parseCommandInvocation, expandCommand, resolveCommand,
  describeCommands, completeCommand, RESERVED_COMMANDS,
} from "../services/slashCommands.mjs";
import { buildConversationFromEvents, dedupeObservations } from "../services/conversationStore.mjs";

// ★ LangGraph runner + working-set memory
import { runKodoGraph } from "../services/graph_runner.mjs";
import {
  getLastTouchedFile,
  recordFilesTouched,
  buildWorkingSetContext,
} from "../services/workingset.mjs";
import { loadMemoryIndex, writeAgentMemory } from "../services/agentMemory.mjs";
import {
  createJob, emitToJob, subscribe, finishJob, cancelJob, getRunningJobs,
} from "../services/jobs.mjs";

const ALLOWED_ORIGIN = process.env.KODO_ALLOWED_ORIGIN || "http://localhost:3000";

// Per-session queue — two concurrent requests for the same session would
// interleave their graph runs and corrupt each other's file edits, so a
// second request for a busy session waits its turn instead of racing (or, as
// before, being rejected outright with a 409). sessionQueues holds the tail
// promise of the chain; registerSessionSlot appends to it and returns a
// release function the caller must call when its own processing is done.
const sessionQueues = new Map(); // sessionId → Promise (resolves when the slot is free)

// Split into register (synchronous — preserves arrival order even if two
// requests land in the same tick) + wait (async — actually blocks until it's
// this request's turn), so the caller can emit a "queued" notice on the SSE
// stream before awaiting, instead of the client seeing dead air.
function registerSessionSlot(sessionId) {
  const hadPrev = sessionQueues.has(sessionId);
  const prevTail = sessionQueues.get(sessionId) || Promise.resolve();
  let releaseMine;
  const mine = new Promise((resolve) => { releaseMine = resolve; });
  sessionQueues.set(sessionId, mine);

  const release = () => {
    releaseMine();
    // Only the last request in the chain cleans up, so the map doesn't grow forever.
    if (sessionQueues.get(sessionId) === mine) sessionQueues.delete(sessionId);
  };
  return { prevTail, release, hadToWait: hadPrev };
}

// Plan approval promises — when permissionMode === "ask", execution pauses here
// until the user clicks Approve (POST /confirm/:requestId) or Cancel (POST /reject/:requestId)
const pendingApprovals = new Map(); // requestId → { resolve, reject }

// Clarifying-question promises — the agent's ask_user tool pauses here until
// the user answers (POST /answer/:requestId). Unlike pendingApprovals this can
// be armed/cleared multiple times over one run (one open question at a time).
const pendingQuestions = new Map(); // requestId → { resolve, reject, questionId }

const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

// Builds the askUser callback threaded into the graph (state.askUser →
// agent_loop's ctx.askUser). Unanswered after the timeout: resolve with a
// "no response" note rather than hanging the run forever — the agent proceeds
// with its own best judgment instead of being stuck.
function makeAskUser(requestId, jobEmit, abortSignal) {
  return function askUser({ question, header, options }) {
    return new Promise((resolve) => {
      const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const settle = (answer) => {
        if (pendingQuestions.get(requestId)?.questionId !== questionId) return;
        clearTimeout(timeoutId);
        pendingQuestions.delete(requestId);
        resolve(answer);
      };

      const timeoutId = setTimeout(() => {
        settle("(no response from the user in time — proceed using your best judgment and note the assumption)");
      }, QUESTION_TIMEOUT_MS);

      pendingQuestions.set(requestId, { questionId, resolve: settle });
      jobEmit({
        type: "question",
        questionId,
        question,
        header: header || "Question",
        options: options || [],
      });

      if (abortSignal?.aborted) settle("(operation cancelled)");
    });
  };
}

// ── Helpers ───────────────────────────────────────────────────

// Per-user settings (multi-user): each user's model/API key is isolated in the
// DB — see services/userSettings.service.mjs. The legacy global data/settings.json
// is migrated (once) only into the very first account on this install, never
// into a later signup, so a new user never silently spends someone else's key.
const loadSettings = loadUserSettings;

function getAuthSessionFromRequest(request) {
  try {
    const auth = request.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) return null;
    const token = auth.slice(7).trim();
    return db
      .prepare("SELECT user_id, workspace_path FROM auth_sessions WHERE token = ?")
      .get(token) || null;
  } catch {
    return null;
  }
}

function requireUserSession(request, reply) {
  const s = getAuthSessionFromRequest(request);
  if (!s?.user_id) {
    reply.code(401).send({ ok: false, error: "Unauthorized" });
    return null;
  }
  return s;
}

function startSSE(reply) {
  reply.raw.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  reply.raw.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection:      "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function setCors(reply) {
  reply.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(i => (typeof i === "string" ? i : i?.path)).filter(s => typeof s === "string" && s.trim());
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(i => typeof i === "string" && i.trim());
    } catch {}
    return trimmed.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function previewText(value, maxChars = 140) {
  const text = String(value || "").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildMemoryContext(memory, workingSetContext = "") {
  const lines = [];
  if (memory) {
    if (memory.last_task)             lines.push(`LAST TASK: ${memory.last_task}`);
    if (memory.last_task_type)        lines.push(`LAST TASK TYPE: ${memory.last_task_type}`);
    if (memory.last_target_file)      lines.push(`LAST TARGET FILE: ${memory.last_target_file}`);
    if (memory.last_user_message)     lines.push(`LAST USER MESSAGE: ${previewText(memory.last_user_message)}`);
    if (memory.last_assistant_message)lines.push(`LAST ASSISTANT MESSAGE: ${previewText(memory.last_assistant_message)}`);
  }
  if (workingSetContext) lines.push(workingSetContext);
  return lines.join("\n").trim();
}

function syncSessionMemory(sessionId, userId, {
  userMessage = "",
  assistantMessage = "",
  attachmentPaths = [],
  task = "",
  taskType = "",
  projectScope = "",
  targetFile = "",
} = {}) {
  if (!sessionId || !userId) return;
  // NOTE: these session-memory setters are session-scoped and take
  // (sessionId, value) — they do NOT take userId. Passing userId as the 2nd arg
  // (as this used to) stored the userId as the value and silently dropped the
  // real data, which is why uploaded files / last messages were never remembered.
  if (userMessage.trim())           rememberUserMessage(sessionId, userMessage.trim());
  if (attachmentPaths.length)       rememberFiles(sessionId, attachmentPaths);
  if (assistantMessage.trim())      rememberAssistantMessage(sessionId, assistantMessage.trim());
  if (task || taskType || projectScope) rememberTask(sessionId, { task, taskType, projectScope });
  if (targetFile.trim())            rememberTargetFile(sessionId, targetFile.trim());
}

// ── Background agent run (decoupled from the HTTP request) ────────────────────
// Runs the graph inside a job so the task survives page refresh / disconnect.
// The HTTP request that started it is just a live subscriber (see
// streamJobToResponse). This function owns everything durable: emitting events
// into the job, persisting the result, updating memory, and releasing the
// per-session queue slot — all independent of whether any client is listening.
async function startBackgroundRun(ctx) {
  const {
    requestId, sessionId, userId, workspacePath, modelRoute, visionRoute, modelMeta,
    plannerContextMessage, rememberedFile, priorMessages = [], priorConversation = [],
    attachmentPaths, effectiveMessage,
    permissionMode, controller, releaseSlot, startEvent,
  } = ctx;

  // Appends this run's tool timeline to the session's working memory. Failing
  // to persist a trace must never abort real work, so every write is guarded.
  const recordEvent = (event) => {
    try {
      appendTurnEvent({ ...event, sessionId, userId, requestId });
    } catch (err) {
      console.warn("[TurnEvents] append failed:", err.message);
    }
  };

  const title = String(effectiveMessage || "").slice(0, 60);
  createJob({ requestId, sessionId, userId, controller, title });

  let finished = false;
  const markFinished = (status) => {
    if (finished) return;
    finished = true;
    try { updateAgentJobStatus(requestId, status); } catch {}
    finishJob(requestId, status);
  };

  // Track whether content streamed + collect diffs for the saved message.
  // Accumulate ALL streamed text so the SAVED message equals what the user saw
  // live — otherwise only `finalAnswer` (the last turn's text) is persisted and
  // the message looks truncated after a reload / session switch.
  let contentEmitted = false;
  let collectedContent = "";
  const collectedFileDiffs = [];
  const jobEmit = (event) => {
    if (event.type === "content") { contentEmitted = true; collectedContent += String(event.content || ""); }
    if (event.type === "file_diff") {
      collectedFileDiffs.push({ action: event.action, path: event.path, language: event.language, hunks: event.hunks });
    }
    emitToJob(requestId, event);
  };

  // Ask-mode approval promise (execute waits on this before the first write).
  let approvalPromise = null;
  let approvalTimeoutId = null;
  if (permissionMode === "ask") {
    approvalPromise = new Promise((resolve, reject) => {
      pendingApprovals.set(requestId, { resolve, reject });
      approvalTimeoutId = setTimeout(() => {
        if (pendingApprovals.has(requestId)) {
          pendingApprovals.delete(requestId);
          reject(new Error("Plan approval timed out"));
        }
      }, 5 * 60 * 1000);
    });
    approvalPromise.catch(() => {});
  }

  const askUser = makeAskUser(requestId, jobEmit, controller.signal);
  controller.signal.addEventListener("abort", () => {
    pendingQuestions.get(requestId)?.resolve("(operation cancelled)");
  });

  const doneEvent = (summary, extra = {}) => ({
    type: "done", request_id: requestId, summary,
    metadata: { type: "graph", request_id: requestId, ...modelMeta, ...extra },
  });

  try {
    createAgentJob({ requestId, sessionId, userId, title });
    jobEmit(startEvent);

    // Raised alongside agent_loop's MAX_ITERATIONS (25→40) and the new
    // parallel-read execution — a real multi-file build can legitimately need
    // more wall-clock time than a single-file fix, and this (now that it
    // actually aborts the run on expiry, see below) is the real outer bound
    // on how long any run is allowed to take.
    const GRAPH_TIMEOUT_MS = 25 * 60 * 1000;
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, timedOut: true }), GRAPH_TIMEOUT_MS)
    );
    const graphPromise = runKodoGraph({
      userMessage:          plannerContextMessage,
      rememberedTargetFile: rememberedFile,
      priorMessages, priorConversation, recordEvent,
      sessionId, requestId, userId, workspacePath, modelRoute, visionRoute,
      attachmentPaths,
      emit: jobEmit,
      abortSignal: controller.signal,
      permissionMode, approvalPromise,
      askUser,
    }).then((r) => ({ ok: true, result: r })).catch((e) => ({ ok: false, error: e }));

    const raceResult = await Promise.race([graphPromise, timeoutPromise]);

    if (approvalTimeoutId !== null) clearTimeout(approvalTimeoutId);
    pendingApprovals.delete(requestId);

    if (raceResult.timedOut) {
      // Promise.race doesn't cancel the loser — without this, agentLoopNode
      // keeps running unattended after the user's already been told to try
      // again, still writing files with nothing watching it, and can then
      // collide with a fresh retry mutating the same files concurrently.
      // agent_loop.mjs already checks abortSignal at each loop iteration, so
      // this makes it actually stop instead of running out the clock unseen.
      controller.abort();
      jobEmit({ type: "content", content: "The task is taking longer than expected. Please try again." });
      jobEmit(doneEvent(""));
      saveMessage(sessionId, userId, "assistant", "(timed out)", "graph", requestId, null);
      touchSession(sessionId, userId);
      markFinished("error");
      return;
    }

    if (!raceResult.ok) {
      const cancelled = controller.signal.aborted;
      const graphError = raceResult.error;
      if (cancelled) {
        jobEmit({ type: "content", content: "Operation cancelled." });
        saveMessage(sessionId, userId, "assistant", "Operation cancelled.", "graph", requestId, null);
      } else {
        console.error("❌ LangGraph error:", graphError);
        jobEmit({ type: "error", error: "Graph execution failed", details: graphError?.message });
        saveMessage(sessionId, userId, "assistant", `Error: ${graphError?.message}`, "error");
        syncSessionMemory(sessionId, userId, { assistantMessage: `Error: ${graphError?.message}` });
      }
      jobEmit(doneEvent(""));
      touchSession(sessionId, userId);
      markFinished(cancelled ? "cancelled" : "error");
      return;
    }

    const finalAnswer = raceResult.result.finalAnswer || "";
    const editedFiles = raceResult.result.editedFiles || [];
    const usage = raceResult.result.usage || null;
    // A clean cancel resolves successfully (agent_loop returns "Operation
    // cancelled." rather than throwing), so detect the abort here for status.
    const wasCancelled = controller.signal.aborted;

    if (finalAnswer && !contentEmitted) jobEmit({ type: "content", content: finalAnswer });
    jobEmit(doneEvent(finalAnswer, usage ? { usage } : {}));

    // Save the FULL streamed text (what the user actually saw) — falls back to
    // finalAnswer if, somehow, nothing streamed.
    const messageToSave = collectedContent.trim() || finalAnswer || "(no output)";
    saveMessage(
      sessionId, userId, "assistant", messageToSave, "graph",
      requestId, collectedFileDiffs.length > 0 ? collectedFileDiffs : null,
    );
    touchSession(sessionId, userId);

    if (editedFiles.length > 0) {
      recordFilesTouched(sessionId, editedFiles, effectiveMessage.slice(0, 80));
    }

    const isRememberCommand = /^remember[:\s]/i.test(effectiveMessage);
    const shouldWriteMemory = !wasCancelled && finalAnswer && (editedFiles.length > 0 || String(effectiveMessage).length > 60 || isRememberCommand);
    if (shouldWriteMemory) {
      writeAgentMemory({ workspacePath, userMessage: effectiveMessage, assistantAnswer: finalAnswer, editedFiles, modelRoute })
        .catch((err) => console.warn("[AgentMemory] background write failed:", err.message));
    }
    if (!wasCancelled) {
      syncSessionMemory(sessionId, userId, {
        assistantMessage: finalAnswer, task: effectiveMessage, taskType: "graph", targetFile: editedFiles[0] || "",
      });
    }

    markFinished(wasCancelled ? "cancelled" : "done");
  } catch (err) {
    console.error("[BackgroundRun] fatal:", err);
    try {
      jobEmit({ type: "error", error: "Internal error", details: String(err?.message || err) });
      jobEmit(doneEvent(""));
    } catch {}
    markFinished("error");
  } finally {
    if (approvalTimeoutId !== null) clearTimeout(approvalTimeoutId);
    pendingApprovals.delete(requestId);
    pendingQuestions.delete(requestId);
    // Keep working memory bounded on long-lived sessions. Unpinned rows only —
    // the active plan and user decisions are never pruned.
    try { pruneTurnEvents(sessionId, userId); } catch (err) {
      console.warn("[TurnEvents] prune failed:", err.message);
    }
    releaseSlot();
  }
}

// Attach an HTTP response as a live subscriber to a running job. Replays any
// buffered events (so a reconnecting client catches up), then streams live
// ones. Resolves when a terminal event arrives OR the client disconnects —
// and a disconnect DETACHES only, it never stops the job.
function streamJobToResponse(requestId, reply, request) {
  return new Promise((resolve) => {
    let settled = false;
    let unsub = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { request.raw.removeListener("close", onClose); } catch {}
      if (unsub) { try { unsub(); } catch {} }
      try { if (!reply.raw.writableEnded) reply.raw.end(); } catch {}
      resolve();
    };

    const onClose = () => finish(); // client went away — job keeps running

    const write = (event) => {
      if (settled) return;
      try {
        if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (e) {
        console.warn("[SSE write]", e.message);
      }
      if (event.type === "done" || event.type === "error") finish();
    };

    request.raw.on("close", onClose);
    unsub = subscribe(requestId, write);
    if (unsub === null) finish(); // job not found (already GC'd)
  });
}

// ── Slash commands (Claude Code approach: /init, /memory, /skills, /help) ────

// ── MCP prompt commands ──────────────────────────────────────────────────────
// Claude Code surfaces a server's prompts as /mcp__<server>__<prompt>. Unlike
// Kodo's other slash commands these don't produce a reply — they expand into
// the user instruction for this turn.

export function isMcpPromptCommand(message) {
  return /^\/mcp__[^\s_]+__\S+/.test(String(message || "").trim());
}

// `/mcp__github__review diff="a b" depth=2 rest of the text`
// → { serverName, promptName, args: {diff:"a b", depth:"2"}, trailing:"rest of the text" }
export function parseMcpPromptCommand(message) {
  const m = String(message || "").trim().match(/^\/mcp__([^\s_]+)__(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const [, serverName, promptName, rest] = m;

  const args = {};
  const leftover = [];
  // key="quoted value" | key=bare | free text
  const re = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))|(\S+)/g;
  let tok;
  while ((tok = re.exec(rest))) {
    if (tok[1]) args[tok[1]] = tok[2] ?? tok[3] ?? tok[4] ?? "";
    else leftover.push(tok[5]);
  }
  return { serverName, promptName, args, trailing: leftover.join(" ").trim() };
}

export async function expandMcpPromptCommand(message, workspacePath) {
  const parsed = parseMcpPromptCommand(message);
  if (!parsed) return { ok: false, error: "Malformed MCP prompt command." };

  const { loadKodoSettings } = await import("../agents/nodes/agent_loop.mjs");
  const { discoverMcpTools, getMcpPrompt, listMcpPrompts } = await import("../services/mcpTools.mjs");
  const { mcpServers } = await loadKodoSettings(workspacePath);

  if (!mcpServers?.[parsed.serverName]) {
    return { ok: false, error: `No MCP server named "${parsed.serverName}" is configured. Run /mcp to see what's available.` };
  }

  const clients = new Map();
  try {
    await discoverMcpTools({
      mcpServers: { [parsed.serverName]: mcpServers[parsed.serverName] },
      cwd: workspacePath,
      mcpClients: clients,
    });
    const res = await getMcpPrompt(parsed.serverName, parsed.promptName, parsed.args, { mcpClients: clients });
    if (!res.success) {
      const available = (await listMcpPrompts(clients)).map((p) => p.command).join(", ") || "(none)";
      return { ok: false, error: `${res.error}\nAvailable prompts: ${available}` };
    }
    // Trailing free text is appended so `/mcp__x__review focus on auth` works
    // without the user having to name every argument.
    const text = parsed.trailing ? `${res.text}\n\n${parsed.trailing}` : res.text;
    if (!text.trim()) return { ok: false, error: `Prompt "${parsed.promptName}" expanded to nothing.` };
    return { ok: true, text };
  } finally {
    // Prompt expansion may run against a pooled client; only close what isn't.
    const { isPooledClient } = await import("../services/mcpTools.mjs");
    for (const c of clients.values()) if (!isPooledClient(c)) { try { c.close(); } catch {} }
  }
}

export async function handleSlashCommand(message, { workspacePath, modelRoute }) {
  const m = String(message || "").trim();
  if (!m.startsWith("/")) return null;
  const [cmdRaw, ...rest] = m.slice(1).split(/\s+/);
  const cmd = (cmdRaw || "").toLowerCase();

  const { loadSkillIndex, walkWorkspace } = await import("../agents/nodes/agent_loop.mjs");
  const { listMemoryTopics, loadMemoryIndex: loadMemIdx } = await import("../services/agentMemory.mjs");
  const { callLLM } = await import("../services/llm.mjs");

  switch (cmd) {
    case "help":
      // Grouped so the two kinds of information stay distinguishable: commands
      // that read YOUR PROJECT vs commands that report KODO'S OWN RUNTIME.
      // Conflating them is what lets runtime state be mistaken for project
      // truth, so the boundary is stated in the UI rather than implied.
      return [
        "**Kodo commands**",
        "",
        "**Your project**",
        "- `/init` — inspect the repository and generate KODO.md (project instructions loaded into every request)",
        "- `/commands` — list custom slash commands defined in `.kodo/commands` and `.kodo/skills`",
        "",
        "**Kodo runtime** _(introspection — describes the agent, not your codebase)_",
        "- `/memory` — what Kodo remembers from past sessions",
        "- `/skills` — expert skills available to load",
        "- `/agents` — subagents, their tools, model and read-only status",
        "- `/hooks` — configured lifecycle hooks, their scope, type and status",
        "- `/mcp` — connected MCP servers, their tools, prompts and resources",
        "- `/mcp__<server>__<prompt> [key=value …]` — run a prompt an MCP server provides",
        "- `/help` — this list",
        "",
        "_Runtime output describes Kodo itself and is never used as evidence about your project — `/init` reads repository files only._",
        "",
        "Anything else you type goes to the agent. Say `remember: <fact>` to save a fact, `forget all memory` to wipe memory.",
      ].join("\n");

    case "hooks": {
      const { loadHookConfig, describeHookConfig, HOOK_EVENTS, EVENT_HANDLER_TYPES } = await import("../services/hooks.mjs");
      const { activeSessionIds } = await import("../services/sessionHooks.mjs");
      const { hooks, warnings, source } = await loadHookConfig(workspacePath);
      const rows = describeHookConfig(hooks);

      // Events Kodo registers but cannot fire because the underlying runtime
      // doesn't exist — shown explicitly so "configured but silent" is never a
      // mystery.
      const UNSUPPORTED = {
        WorktreeCreate: "no git-worktree runtime", WorktreeRemove: "no git-worktree runtime",
        TaskCreated: "no task runtime", TaskCompleted: "no task runtime", TeammateIdle: "no concurrent workers",
        Elicitation: "MCP elicitation not implemented", ElicitationResult: "MCP elicitation not implemented",
        MessageDisplay: "no display-transform layer", Notification: "no notification channel",
        CwdChanged: "workspace cwd is fixed per request", FileChanged: "no filesystem watcher",
        ConfigChange: "no settings watcher", InstructionsLoaded: "not wired",
      };

      const lines = [`**Hooks** — \`${source}\``];
      if (warnings.length) lines.push("", ...warnings.map((w) => `- ⚠️ ${w}`));

      const configured = HOOK_EVENTS.filter((e) => rows.some((r) => r.event === e));
      if (configured.length) {
        lines.push("", "**Active**");
        for (const event of configured) {
          lines.push(`- **${event}**`);
          for (const r of rows.filter((x) => x.event === event)) {
            // Only the handler's target is shown; payloads and env are never
            // rendered, so no secret can leak through the inspector.
            const scope = r.legacy ? "project (legacy)" : "project";
            lines.push(`    - ✓ ${scope} · \`${r.type}\` · matcher \`${r.matcher}\` · ${r.timeout}s · \`${String(r.target).slice(0, 60)}\``);
          }
        }
      } else {
        lines.push("", "_No hooks configured._");
      }

      const inert = configured.filter((e) => UNSUPPORTED[e]);
      if (inert.length) {
        lines.push("", "**Configured but NOT fired** (underlying runtime missing)");
        for (const e of inert) lines.push(`- ✗ **${e}** — ${UNSUPPORTED[e]}`);
      }

      lines.push("", `**Runtime** — ${activeSessionIds().length} active session(s)`);
      lines.push(`_Events supported: ${HOOK_EVENTS.length}. Handler types per event vary (e.g. SessionStart: ${EVENT_HANDLER_TYPES.SessionStart.join(", ")})._`);
      return lines.join("\n");
    }

    case "commands": {
      const { commands, conflicts, errors } = await loadCommandRegistry(workspacePath);
      const rows = describeCommands(commands);
      const lines = ["**Custom slash commands** — project `.kodo/` and user `~/.kodo/`"];
      if (!rows.length) {
        lines.push("", "_None defined. Create `.kodo/commands/deploy.md` to add `/deploy`._");
      } else {
        let category = null;
        for (const c of rows) {
          if (c.category !== category) { category = c.category; lines.push("", `**${category}**`); }
          const alias = c.aliases.length ? ` (aliases: ${c.aliases.map((a) => `/${a}`).join(", ")})` : "";
          lines.push(`- **/${c.name}**${c.version ? ` v${c.version}` : ""}${alias} — ${c.description}`);
          lines.push(`    - usage: \`${c.usage}\``);
          lines.push(`    - scope: ${c.scope} · source: ${c.source === "commands" ? "`.kodo/commands`" : "`.kodo/skills`"} · \`${c.file}\``);
          if (c.arguments.length) {
            lines.push(`    - arguments: ${c.arguments.map((a) => `${a.name}${a.required ? "*" : ""}${a.enum?.length ? `=${a.enum.join("|")}` : ""}${a.default ? ` (default ${a.default})` : ""}`).join(", ")}`);
          }
          if (c.requires.length) lines.push(`    - requires: ${c.requires.join(", ")}`);
          if (c.declaredPermissions.length) {
            lines.push(`    - declares (advisory only, grants nothing): ${c.declaredPermissions.join(", ")}`);
          }
          if (c.examples.length) lines.push(`    - e.g. ${c.examples.map((e) => `\`${e}\``).join(" · ")}`);
          lines.push(`    - status: ${c.enabled ? "enabled" : `⚠️ disabled — ${c.disabledReason}`}`);
        }
      }
      if (conflicts.length) {
        lines.push("", "**Conflicts** (not loaded)");
        for (const c of conflicts) lines.push(`- ⚠️ ${c}`);
      }
      if (errors.length) {
        lines.push("", "**Invalid**");
        for (const e of errors) lines.push(`- ⚠️ ${e}`);
      }
      lines.push("", "_Command bodies are not shown. A command expands into your prompt — it cannot grant tools or bypass permissions._");
      return lines.join("\n");
    }

    case "agents": {
      const { loadSubagentRegistry, describeAgents, SUBAGENT_BASE_READONLY_TOOLS, SUBAGENT_WRITE_TOOLS } =
        await import("../services/subagentRegistry.mjs");
      const { agents, errors } = await loadSubagentRegistry(workspacePath);
      // Compose against the full built-in ceiling so the inspector shows what
      // each agent WOULD get; a live run intersects with that run's tools too.
      const parentTools = new Set([...SUBAGENT_BASE_READONLY_TOOLS, ...SUBAGENT_WRITE_TOOLS]);
      const rows = describeAgents(agents, parentTools);

      const lines = ["**Subagents** — `.kodo/agents/*.md`"];
      for (const a of rows) {
        lines.push("", `- **${a.name}**${a.builtin ? " _(built-in)_" : ""} — ${a.description}`);
        lines.push(`    - source: \`${a.source}\``);
        lines.push(`    - access: ${a.readOnly ? "🔒 read-only" : "✏️ WRITE-CAPABLE (explicit opt-in)"} · mode \`${a.permissionMode}\``);
        lines.push(`    - model: ${a.model} · maxTurns: ${a.maxTurns}`);
        lines.push(`    - isolation: ${a.isolation === "worktree" ? "🌳 git worktree (real, auto-removed on completion/failure/abort)" : "none (runs in the workspace)"}`);
        lines.push(`    - execution: ${a.background ? "⏳ background (returns a task_id; collect with subagent_status)" : "foreground (blocks until done)"}`);
        lines.push(`    - tools: ${a.effectiveTools?.length ? a.effectiveTools.join(", ") : "(none available)"}`);
        if (a.refusedTools?.length) {
          lines.push(`    - refused: ${a.refusedTools.map((r) => `${r.name} (${r.why})`).join(", ")}`);
        }
      }
      if (errors.length) {
        lines.push("", "**Invalid definitions** (not loaded)");
        for (const e of errors) lines.push(`- ⚠️ ${e}`);
      }
      lines.push("", "_Prompt bodies are not shown. Subagent tools are always an intersection with the parent's — a definition can never widen access._");
      return lines.join("\n");
    }

    case "memory": {
      const index = await loadMemIdx(workspacePath);
      const topics = await listMemoryTopics(workspacePath);
      if (!topics.length) return "No memory yet — Kodo saves project knowledge automatically as you work.";
      return `**Memory index**\n${index || topics.map((t) => `- ${t}`).join("\n")}`;
    }

    case "skills": {
      const skills = await loadSkillIndex(workspacePath);
      if (!skills.length) return "No skills installed. Add markdown packs to `.kodo/skills/` (frontmatter: name, description).";
      return `**Available skills**\n${skills.map((s) => `- **${s.name}** — ${s.description}`).join("\n")}`;
    }

    // Connects to each declared server and reports what actually came up —
    // a config listing would hide the common failure (server not installed).
    case "mcp": {
      const { loadKodoSettings } = await import("../agents/nodes/agent_loop.mjs");
      const { discoverMcpTools } = await import("../services/mcpTools.mjs");
      const { mcpServers } = await loadKodoSettings(workspacePath);
      const names = Object.keys(mcpServers || {});
      if (!names.length) {
        return [
          "No MCP servers configured.",
          "",
          "Add them to `.kodo/settings.json`:",
          "```json",
          '{ "mcpServers": {',
          '  "playwright": { "command": "npx", "args": ["@playwright/mcp", "--headless"] },',
          '  "remote":     { "type": "http", "url": "https://example.com/mcp" }',
          "} }",
          "```",
        ].join("\n");
      }
      const clients = new Map();
      try {
        const { servers } = await discoverMcpTools({ mcpServers, cwd: workspacePath, mcpClients: clients });
        const { listMcpPrompts, listMcpResources, isPooledClient } = await import("../services/mcpTools.mjs");
        const [prompts, resources] = await Promise.all([listMcpPrompts(clients), listMcpResources(clients)]);

        const lines = [`**MCP servers**`, ...servers.map((s) => (
          s.ok
            ? `- ✅ **${s.name}** — ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`
            : `- ❌ **${s.name}** — ${s.error || "unavailable"}`
        ))];
        if (prompts.length) {
          lines.push("", "**Prompts** (run one as a command)", ...prompts.map((p) => `- \`${p.command}\`${p.description ? ` — ${p.description}` : ""}`));
        }
        if (resources.length) {
          lines.push("", "**Resources** (the agent reads these on demand)", ...resources.slice(0, 20).map((r) => `- \`${r.uri}\`${r.name && r.name !== r.uri ? ` — ${r.name}` : ""}`));
        }
        // Only close clients this command owns; pooled ones outlive it.
        for (const c of clients.values()) if (!isPooledClient(c)) { try { c.close(); } catch {} }
        clients.clear();
        return lines.join("\n");
      } finally {
        for (const c of clients.values()) { try { c.close(); } catch {} }
      }
    }

    case "init": {
      // PROJECT DATA ONLY. walkWorkspace excludes .kodo/.claude;
      // collectProjectEvidence independently excludes those AND every git
      // worktree under the workspace, so a temporary subagent checkout is
      // never mistaken for the project.
      const tree = await walkWorkspace(workspacePath, 6);
      const evidence = await collectProjectEvidence(workspacePath, { tree });

      // Generate → validate → repair. Nothing is written until a draft passes;
      // an invalid document is discarded and regenerated with the validator's
      // own findings fed back as corrections.
      const outcome = await generateValidatedKodoMd({
        evidence,
        generate: async ({ system, user }) => {
          const result = await callLLM({
            system,
            messages: [{ role: "user", content: user }],
            modelRoute,
            maxTokens: 2500,
            temperature: 0.2,
          });
          return String(result?.content || "");
        },
      });

      const kodoPath = path.join(workspacePath, "KODO.md");

      if (!outcome.ok) {
        // Retries exhausted. Do NOT overwrite — an existing KODO.md, even a
        // stale one, is better than one with known unsupported claims.
        let existing = false;
        try { await fs.access(kodoPath); existing = true; } catch {}
        return [
          `Could not generate a valid KODO.md after ${outcome.attemptsUsed} attempt(s). **Nothing was written.**`,
          existing ? "Your existing `KODO.md` is unchanged." : "No `KODO.md` was created.",
          "",
          "The generated drafts kept failing these checks:",
          ...outcome.violations.slice(0, 8).map((v) => `- ${v.detail}`),
          "",
          `_Inspected ${evidence.filesInspected.length} file(s)${evidence.excludedWorktrees.length ? `; excluded ${evidence.excludedWorktrees.length} worktree(s)` : ""}. Try again, or write KODO.md by hand._`,
        ].join("\n");
      }

      const finalContent = `${outcome.content}\n${evidenceFooter(evidence)}\n`;
      await fs.writeFile(kodoPath, finalContent, "utf-8");

      const excluded = evidence.excludedWorktrees.length
        ? `\n\n**Excluded ${evidence.excludedWorktrees.length} worktree(s)** (not part of this project): ${evidence.excludedWorktrees.map((w) => `\`${w}\``).join(", ")}`
        : "";
      const inspected = evidence.filesInspected.length
        ? `\n\n**Files inspected:** ${evidence.filesInspected.map((f) => `\`${f}\``).join(", ")}`
        : "\n\n**No manifest files were found** — the document is based on the file tree alone, so most of it will be under _Inferred_.";
      const retried = outcome.attemptsUsed > 1
        ? `\n\n_Validation rejected ${outcome.attemptsUsed - 1} earlier draft(s); the written document passed all checks._`
        : "";

      return `Created **KODO.md** (${finalContent.split("\n").length} lines), validated against ${evidence.filesInspected.length} inspected file(s).${inspected}${excluded}${retried}\n\n${outcome.content.slice(0, 1200)}${outcome.content.length > 1200 ? "\n…" : ""}`;
    }

    default:
      return `Unknown command \`/${cmd}\`. Try \`/help\`.`;
  }
}

// ── Route ──────────────────────────────────────────────────────

export default async function plannerAgentRoute(fastify) {

  fastify.get("/capabilities", async (request, reply) => {
    setCors(reply);
    const authSession = getAuthSessionFromRequest(request);
    const settings = await loadSettings(authSession?.user_id);
    return { ok: true, ...getCapabilities(settings) };
  });

  // POST /run — main chat endpoint (LangGraph)
  fastify.post("/run", async (request, reply) => {
    setCors(reply);

    const authSession = requireUserSession(request, reply);
    if (!authSession) return;

    const userId = authSession.user_id;
    const body   = await parseIncomingPayload(request);

    const message =
      typeof body.message === "string" ? body.message.trim()
      : typeof body.text   === "string" ? body.text.trim()
      : typeof body.prompt === "string" ? body.prompt.trim()
      : "";

    const session_id = typeof body.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim()
      : "";

    const attachment_paths = uniq([
      ...toStringArray(body.attachment_paths),
      ...toStringArray(body.attachments),
      ...toStringArray(body.files),
    ]);

    const permissionMode =
      body.permission_mode === "ask"  ? "ask"
      : body.permission_mode === "plan" ? "plan"
      : "auto";

    const workspacePath = authSession.workspace_path || "";

    // No bound workspace = refuse, don't silently fall back to the server's
    // own repo (agent_loop.mjs's PROJECT_ROOT fallback). Multiple accounts can
    // share one running backend, and a fallback here isn't just a read-only
    // view leak like the file tree — the agent WRITES files, so an unconfigured
    // user would otherwise be editing whichever project the server happens to
    // be running from.
    if (!workspacePath) {
      return reply.code(400).send({
        ok: false,
        error: "no_workspace",
        message: "No project connected yet. Open Kodo from your project (via the extension) or pick one from the folder switcher before chatting.",
      });
    }

    const settings       = await loadSettings(userId);
    // Only images require a vision model; text/PDF are extracted to text and
    // work with any model, so the gate keys off image attachments specifically.
    const hasImageAttachments = attachment_paths.some((p) => isImageMime(inferMimeTypeFromPath(p), p));
    const modelRoute     = routeModel(settings, { hasImageAttachments });
    // Independent of this turn's attachments — verify_ui may want to
    // escalate a UI-check failure to vision mid-run regardless of whether
    // THIS message happened to include an image. {ok:false} just means no
    // vision model is configured; that's fine, escalation silently no-ops.
    const visionRoute    = routeModel(settings, { hasImageAttachments: true });

    if (!modelRoute.ok) {
      const errorMap = {
        no_config:        { error: "not_configured",   action: "open_settings" },
        no_vision:        { error: "no_vision_model",  action: "open_settings" },
        model_no_vision:  { error: "model_no_vision",  action: "open_settings" },
      };
      const mapped = errorMap[modelRoute.error] || { error: modelRoute.error };
      return reply.code(400).send({ ok: false, message: modelRoute.message, ...mapped });
    }

    let effectiveMessage = message
      || (attachment_paths.length ? "Please analyse the uploaded attachment(s)." : "");

    if (!effectiveMessage) {
      return reply.code(400).send({ ok: false, error: "Message is required" });
    }

    // MCP prompt commands (/mcp__<server>__<prompt> [k=v …]) are not replies —
    // they EXPAND into the turn's actual instruction, exactly as Claude Code
    // treats a server-provided prompt. Resolve here, before the planner
    // context is assembled, so the rest of the pipeline sees ordinary text.
    if (isMcpPromptCommand(effectiveMessage)) {
      const expanded = await expandMcpPromptCommand(effectiveMessage, workspacePath);
      if (!expanded.ok) {
        return reply.code(400).send({ ok: false, error: expanded.error });
      }
      effectiveMessage = expanded.text;
    }

    // What the user literally typed, captured before ANY expansion (slash
    // command, MCP prompt, or hook) can rewrite it. History records this.
    const typedMessage = effectiveMessage;

    // Custom slash commands (.kodo/commands/*.md and .kodo/skills/**). Expanded
    // here — before the planner — so they are real prompt expansion rather than
    // a fake built-in. Built-ins keep their own handler further down and are
    // never shadowed (see RESERVED_COMMANDS).
    let slashCommand = null;
    {
      const invocation = parseCommandInvocation(effectiveMessage);
      if (invocation && !RESERVED_COMMANDS.has(invocation.name)) {
        const { commands, aliases, conflicts } = await loadCommandRegistry(workspacePath);
        for (const c of conflicts) console.warn(`[SlashCommand] ${c}`);
        // Resolve through aliases too, so /d works when declared as an alias.
        if (resolveCommand(invocation.name, commands, aliases)) {
          const result = expandCommand(invocation, commands, { aliases, workspacePath });
          // A bad argument must fail loudly with usage, not silently expand.
          if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
          slashCommand = {
            name: result.command.name,
            args: invocation.args,
            named: invocation.named,
            values: result.values,
            source: result.command.source,
            scope: result.command.scope,
            file: result.command.file,
          };
          effectiveMessage = result.expanded;
        }
      }
    }

    const sessionId = session_id
      || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // ── Session + prompt lifecycle hooks ─────────────────────────────────────
    // This route owns session/request lifecycle; the agent loop is per-turn and
    // must never fire these (Setup/SessionStart would then run per iteration).
    const hookRunner = await createHookRunner({ workspacePath });
    // A session already in the DB is a RESUME; anything else is new. Checked
    // before createSession() below, which is upsert-style and would erase the
    // distinction.
    const sessionExisted = sessionExists(sessionId, userId);

    await ensureSetup({ workspacePath, fire: hookRunner.fire });
    const sessionStart = await ensureSessionStart({
      sessionId, userId, workspacePath, isNew: !sessionExisted, fire: hookRunner.fire,
    });
    attachRunner(sessionId, hookRunner);

    // Live config reload. The watcher is refcounted per workspace and released
    // on SessionEnd; ConfigChange fires only after a new config is ACCEPTED, so
    // an invalid edit rolls back silently instead of announcing a change.
    // In-flight runs are unaffected — they snapshot their hooks at run start.
    if (sessionStart.fired) {
      try {
        await acquireConfigWatcher(workspacePath, sessionId, async (payload) => {
          const fresh = await createHookRunner({ workspacePath });
          await fresh.fire("ConfigChange", payload);
        });
      } catch (err) {
        console.warn("[ConfigWatcher] could not start:", err.message);
      }
    }

    // The user's words, preserved verbatim for history/auditing. This is what
    // they TYPED (e.g. "/deploy staging"), not the expanded command body — a
    // slash command must stay recognisable in the transcript.
    const originalMessage = typedMessage;

    // UserPromptSubmit — runs BEFORE the model sees anything, and can veto.
    const submit = await hookRunner.fire("UserPromptSubmit", {
      prompt: originalMessage, session_id: sessionId, request_id: requestId, cwd: workspacePath,
    });
    if (submit.decision === "block") {
      const why = submit.reason || "Blocked by a UserPromptSubmit hook.";
      // Persist the attempt so a blocked prompt is auditable rather than vanishing.
      try {
        createSession(sessionId, userId, normalizeSessionLabel(originalMessage, []));
        saveMessage(sessionId, userId, "user", originalMessage, null, requestId, null, null);
        saveMessage(sessionId, userId, "assistant", `⛔ ${why}`, "hook_blocked", requestId, null);
      } catch { /* auditing must not mask the block */ }
      return reply.code(403).send({ ok: false, error: "blocked_by_hook", message: why, session_id: sessionId });
    }

    // UserPromptExpansion — may rewrite the instruction the agent actually runs.
    const expansion = await hookRunner.fire("UserPromptExpansion", {
      prompt: originalMessage, session_id: sessionId, request_id: requestId, cwd: workspacePath,
      // A slash command IS a prompt expansion, so the hook sees it as one.
      ...(slashCommand ? {
        expansion_type: "slash_command",
        command_name: slashCommand.name,
        command_args: slashCommand.args,
        command_source: slashCommand.source,
        command_scope: slashCommand.scope,
        command_values: slashCommand.values,
        command_file: slashCommand.file,
        expanded_prompt: effectiveMessage,
      } : {}),
    });
    if (expansion.decision === "block") {
      const why = expansion.reason || "Blocked by a UserPromptExpansion hook.";
      return reply.code(403).send({ ok: false, error: "blocked_by_hook", message: why, session_id: sessionId });
    }
    if (expansion.updatedPrompt) effectiveMessage = expansion.updatedPrompt;

    // Context contributed by SessionStart/UserPromptSubmit/Expansion hooks is
    // appended (never substituted) so it can inform the model without
    // displacing what the user actually asked for.
    const hookContext = [...(sessionStart.context || []), ...submit.context, ...expansion.context]
      .filter(Boolean).join("\n");

    // ★ Memory: read DB memory + working-set of recent files
    const memory            = getMemory(sessionId, userId);
    const workingSetContext = buildWorkingSetContext(sessionId);
    const memoryContext     = buildMemoryContext(memory, workingSetContext);

    // ★ Agent memory: file-based cross-session knowledge (MEMORY.md index)
    const agentMemoryIndex  = await loadMemoryIndex(workspacePath);

    // ★ Working memory: replay this session's real execution timeline (tool
    //   calls, their results, failures) so the agent continues the previous
    //   turn instead of restarting. Read before this turn's user message is
    //   persisted (further down), so it holds only completed history and never
    //   duplicates the request we're about to run. `priorMessages` stays as the
    //   text-only fallback for sessions recorded before the timeline existed.
    const priorConversation = buildConversationFromEvents(
      dedupeObservations(getTurnEvents(sessionId, userId)),
    );
    const priorMessages = priorConversation.length
      ? []
      : getSessionMessages(sessionId, userId, 12).map((m) => ({ role: m.role, content: m.content }));

    // ★ The file the user most recently edited in this session.
    //   Validate: must look like a real path (slash or extension), else ignore.
    function isRealPath(p) {
      return typeof p === "string" && p.length > 4 &&
             (p.includes("/") || /\.[a-z0-9]+$/i.test(p));
    }
    const wsFile  = getLastTouchedFile(sessionId);
    const memFile = memory?.last_target_file || "";
    const rememberedFile = isRealPath(wsFile) ? wsFile
                         : isRealPath(memFile) ? memFile
                         : "";

    // Load uploaded attachments into readable context: PDFs/text → extracted
    // text, images → vision analysis. Without this the model never actually
    // "sees" an attachment and (for a PDF) says "no file attached".
    //
    // Include the session's PREVIOUSLY-uploaded files too (from memory), not
    // just this turn's — so a resume uploaded once stays readable for the rest
    // of the conversation ("i want to hire him" after "analyze this pdf").
    const rememberedAttachments = Array.isArray(memory?.last_attachment_paths)
      ? memory.last_attachment_paths
      : [];
    const allAttachmentPaths = uniq([...attachment_paths, ...rememberedAttachments]);
    let attachmentContext = "";
    let loadedItems = [];
    if (allAttachmentPaths.length) {
      try {
        loadedItems = await loadAttachmentsFromPaths(allAttachmentPaths);
        attachmentContext = buildAttachmentContext(loadedItems);
      } catch (err) {
        console.warn("[Attachments] failed to load:", err.message);
      }
    }

    // Always include the "Conversation memory:" label so the cleanMessage split
    // in agentic_explore / plan_changes reliably strips everything below it —
    // including the "Agent memory:" section whose filenames would otherwise
    // pollute the name-match fast-path word list.
    // Attachment content goes FIRST (right under the user message) so the model
    // sees it prominently, above the memory sections.
    const plannerContextMessage = [
      effectiveMessage,
      attachmentContext ? `Attached files (content below):\n${attachmentContext}` : "",
      hookContext ? `Context from hooks:\n${hookContext}` : "",
      `Conversation memory:\n${memoryContext || "(none)"}`,
      agentMemoryIndex  ? `Agent memory:\n${agentMemoryIndex}`          : "",
    ].filter(Boolean).join("\n\n");

    // ── Concurrent-request queue ──────────────────────────────────────────────
    // Two parallel graph runs for the same session would corrupt each other's
    // file edits, so register this request's place in line now (synchronous —
    // preserves arrival order); the actual wait happens further down, after the
    // SSE stream is open and can tell the client it's queued.
    const { prevTail: sessionSlotPrevTail, release: releaseSessionSlot, hadToWait: sessionSlotQueued } = registerSessionSlot(sessionId);

    // Attachment chips to persist on THIS turn's user message so they survive
    // a reload / session switch (name + type + size; sizes come from the loaded
    // items when available).
    const userAttachmentsMeta = attachment_paths.length
      ? attachment_paths.map((p) => {
          const it = loadedItems.find((x) => x.path === p);
          return {
            name: it?.originalName || String(p).split("/").pop() || p,
            type: it?.mimeType || inferMimeTypeFromPath(p),
            size: it?.size || 0,
          };
        })
      : null;

    const sessionLabel = normalizeSessionLabel(message, []);
    createSession(sessionId, userId, sessionLabel);
    // History records what the USER actually typed. When a hook rewrote it, the
    // expansion is persisted as a separate turn_events row so both remain
    // distinguishable for auditing instead of the original being overwritten.
    saveMessage(sessionId, userId, "user", originalMessage, null, requestId, null, userAttachmentsMeta);
    if (effectiveMessage !== originalMessage) {
      try {
        const via = slashCommand ? `slash command /${slashCommand.name}` : "UserPromptExpansion hook";
        appendTurnEvent({
          sessionId, userId, requestId, kind: "user",
          content: `[expanded by ${via}]\n${effectiveMessage}`,
        });
      } catch (err) { console.warn("[Prompt] could not record expansion:", err.message); }
    }
    touchSession(sessionId, userId);
    syncSessionMemory(sessionId, userId, {
      userMessage: effectiveMessage,
      attachmentPaths: attachment_paths,
    });

    const msgId     = `msg_${Date.now()}`;
    const timestamp = new Date().toISOString();
    const lang      = detectLanguage(plannerContextMessage);

    const modelMeta = {
      model:        modelRoute.model,
      provider:     modelRoute.provider,
      switchedModel: modelRoute.switchedModel || false,
      switchedFrom: modelRoute.switchedFrom || null,
      switchedTo:   modelRoute.switchedTo   || null,
    };

    startSSE(reply);

    const startEvent = {
      type:       "start",
      id:         msgId,
      session_id: sessionId,
      request_id: requestId,
      createdAt:  timestamp,
      metadata:   { intent: "graph", ...modelMeta },
    };

    // Direct writer for events produced BEFORE the background job exists
    // (queue notice, slash-command replies). Graph events go through the job.
    const sseWrite = (event) => {
      try { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); }
      catch (e) { console.warn("[SSE emit] write error:", e.message); }
    };

    // Wait for our turn if a previous request for this session is still
    // running — the client sees a "queued" notice instead of dead air.
    if (sessionSlotQueued) {
      sseWrite({ type: "progress", stage: "queued", message: "⏳ Waiting for a previous request in this session to finish..." });
    }
    await sessionSlotPrevTail.catch(() => {}); // don't let a prior failure jam the queue

    // ── Slash commands: fast, synchronous, no background job ─────────────────
    if (effectiveMessage.startsWith("/")) {
      try {
        const slashReply = await handleSlashCommand(effectiveMessage, { workspacePath, modelRoute });
        if (slashReply) {
          sseWrite(startEvent);
          sseWrite({ type: "content", content: slashReply });
          sseWrite({ type: "done", request_id: requestId, summary: slashReply, metadata: { type: "command", request_id: requestId, ...modelMeta } });
          reply.raw.end();
          saveMessage(sessionId, userId, "assistant", slashReply, "command");
          touchSession(sessionId, userId);
          releaseSessionSlot();
          return reply;
        }
      } catch (err) {
        const msg = `Command failed: ${err.message}`;
        sseWrite(startEvent);
        sseWrite({ type: "content", content: msg });
        sseWrite({ type: "done", request_id: requestId, summary: msg, metadata: { type: "command", request_id: requestId, ...modelMeta } });
        reply.raw.end();
        releaseSessionSlot();
        return reply;
      }
    }

    // ── Start the agent as a BACKGROUND JOB, then stream it to this request ──
    // The job runs independently of this HTTP connection: if the client
    // refreshes or disconnects, the job keeps going and can be reconnected via
    // GET /run/:requestId/stream. The job (not this request) owns persistence
    // and the per-session queue-slot release. abortSignal is only tripped by an
    // explicit POST /cancel/:requestId — never by the connection closing.
    const jobController = new AbortController();
    void startBackgroundRun({
      requestId, sessionId, userId, workspacePath, modelRoute, visionRoute, modelMeta,
      plannerContextMessage, rememberedFile, priorMessages, priorConversation,
      attachmentPaths: attachment_paths,
      effectiveMessage, permissionMode,
      controller: jobController,
      releaseSlot: releaseSessionSlot,
      startEvent,
    });

    await streamJobToResponse(requestId, reply, request);
    return reply;
  });

  // ── GET /jobs — running background jobs for the user (reconnect discovery) ──
  // Called on page load / session open so the UI can re-attach to a task that's
  // still running after a refresh.
  fastify.get("/jobs", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    const sessionId = typeof request.query?.session_id === "string" ? request.query.session_id.trim() : null;
    const live = getRunningJobs(authSession.user_id, sessionId || null);
    return reply.send({ ok: true, jobs: live });
  });

  // ── GET /run/:requestId/stream — reconnect to a running job's live stream ──
  fastify.get("/run/:requestId/stream", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    const { requestId } = request.params;

    // Ownership check via the durable job record.
    const record = getAgentJob(requestId, authSession.user_id);
    if (!record) {
      return reply.code(404).send({ ok: false, error: "No such job for this user" });
    }

    startSSE(reply);
    // subscribe replays buffered events then streams live ones; if the job is
    // already gone from memory (finished + GC'd), the stream just ends and the
    // client falls back to the saved session messages.
    await streamJobToResponse(requestId, reply, request);
    return reply;
  });

  // ── POST /cancel/:requestId — explicitly stop a running job ────────────────
  fastify.post("/cancel/:requestId", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    const { requestId } = request.params;
    const record = getAgentJob(requestId, authSession.user_id);
    if (!record) return reply.code(404).send({ ok: false, error: "No such job for this user" });
    const ok = cancelJob(requestId);
    return reply.send({ ok: true, cancelled: ok });
  });

  // ── Unchanged endpoints ────────────────────────────────────

  fastify.get("/plan/:filename", async (request, reply) => {
    setCors(reply);
    const { filename } = request.params;
    if (!/^planner(_plan|\d+)\.json$/.test(filename)) {
      return reply.code(400).send({ ok: false, error: "Invalid filename format" });
    }
    const filepath = path.join(PLANS_DIR, filename);
    try {
      const plan = JSON.parse(await fs.readFile(filepath, "utf-8"));
      return reply.send({ ok: true, plan, filename, filepath });
    } catch (error) {
      if (error.code === "ENOENT") return reply.code(404).send({ ok: false, error: "Plan not found" });
      return reply.code(500).send({ ok: false, error: "Failed to read plan", details: error.message });
    }
  });

  fastify.get("/sessions", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    try {
      return reply.send({ ok: true, sessions: listSessions(authSession.user_id) });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: "Failed to list sessions", details: error.message });
    }
  });

  fastify.get("/sessions/:sessionId", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    try {
      const messages = getSessionMessages(request.params.sessionId, authSession.user_id);
      return reply.send({ ok: true, session_id: request.params.sessionId, messages });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: "Failed to get session", details: error.message });
    }
  });

  // Autocomplete for the composer's slash-command menu. Metadata only —
  // command bodies are never returned.
  fastify.get("/commands", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    const workspacePath = authSession.workspace_path || process.cwd();
    const { commands, aliases, conflicts, errors } = await loadCommandRegistry(workspacePath);
    const prefix = String(request.query?.q ?? "");
    return reply.send({
      ok: true,
      completions: prefix ? completeCommand(prefix, commands, aliases) : [],
      commands: describeCommands(commands),
      conflicts,
      errors,
    });
  });

  // ── Pending interactions (MCP elicitation) ─────────────────────────────────
  // The runtime opens an interaction; the client lists and answers it here.
  // Nothing auto-answers: an interaction that is never answered times out as
  // "cancel", which is the safe outcome.
  fastify.get("/interactions", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    const { interactions } = await import("../services/interactionManager.mjs");
    return reply.send({ ok: true, pending: interactions.listPending(request.query?.session_id || null) });
  });

  fastify.post("/interactions/:id/respond", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;

    const { interactions } = await import("../services/interactionManager.mjs");
    const { action, content, reason } = parseIncomingPayload(request) || {};
    if (!["accept", "decline", "cancel"].includes(String(action))) {
      return reply.code(400).send({ ok: false, error: 'action must be "accept", "decline" or "cancel"' });
    }
    // Unknown/expired ids return ok:false rather than throwing, so a duplicate
    // submit from a retrying client is a harmless no-op.
    const delivered = interactions.respond(request.params.id, { action, content, reason });
    return reply.send({ ok: delivered, delivered, id: request.params.id });
  });

  fastify.delete("/sessions/:sessionId", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    try {
      // SessionEnd runs BEFORE the rows disappear, so a cleanup hook can still
      // read the session it is closing. Hook failure must not block deletion.
      try {
        await endSession({
          sessionId: request.params.sessionId,
          reason: String(request.query?.reason || "clear"),
          fire: (await createHookRunner({ workspacePath: authSession.workspace_path || process.cwd() })).fire,
          extra: { force: true },
        });
      } catch (err) {
        console.warn("[Hooks] SessionEnd failed on delete:", err.message);
      }
      deleteSession(request.params.sessionId, authSession.user_id);
      return reply.send({ ok: true, deleted: request.params.sessionId });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: "Failed to delete session", details: error.message });
    }
  });

  fastify.post("/transcribe", async (request, reply) => {
    setCors(reply);
    try {
      if (typeof request.file !== "function") {
        return reply.code(400).send({ ok: false, error: "Multipart upload is not enabled." });
      }
      const data = await request.file();
      if (!data) return reply.code(400).send({ ok: false, error: "No audio file provided." });

      const tempDir = path.join(process.cwd(), "temp_audio");
      await fs.mkdir(tempDir, { recursive: true });
      const tempAudioPath = path.join(tempDir, `audio_${Date.now()}.webm`);
      await pipeline(data.file, createWriteStream(tempAudioPath));

      const response = await openai.audio.transcriptions.create({
        model: WHISPER_MODEL || "whisper-1",
        file:  createReadStream(tempAudioPath),
      });
      await fs.unlink(tempAudioPath).catch(() => {});

      const transcript = (response.text || "").trim();
      if (!transcript) throw new Error("Empty transcription returned");

      return reply.send({ ok: true, transcribed_text: transcript });
    } catch (error) {
      const isRateLimit = /rate limit|429/.test(error.message);
      return reply.code(isRateLimit ? 429 : 500).send({
        ok: false,
        error: isRateLimit ? "Whisper API rate limit reached." : "Failed to transcribe audio",
        details: error.message,
      });
    }
  });

  fastify.post("/undo", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    try {
      const body = await parseIncomingPayload(request);
      const sessionId  = typeof body.session_id  === "string" ? body.session_id.trim()  : null;
      const requestId_ = typeof body.request_id  === "string" ? body.request_id.trim()  : null;
      if (!sessionId || !requestId_) {
        return reply.code(400).send({ ok: false, error: "session_id and request_id are required" });
      }
      const result = undoRequestChanges({ sessionId, requestId: requestId_, userId: authSession.user_id });
      return reply.send({ ok: true, session_id: sessionId, request_id: requestId_, result });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "Failed to undo changes", details: err.message });
    }
  });

  // ── Plan approval (permission mode = "ask") ─────────────────
  fastify.post("/confirm/:requestId", async (request, reply) => {
    setCors(reply);
    const { requestId } = request.params;
    const pending = pendingApprovals.get(requestId);
    if (!pending) {
      return reply.code(404).send({ ok: false, error: "No pending plan approval for this request" });
    }
    pending.resolve();
    pendingApprovals.delete(requestId);
    return { ok: true };
  });

  fastify.post("/reject/:requestId", async (request, reply) => {
    setCors(reply);
    const { requestId } = request.params;
    const pending = pendingApprovals.get(requestId);
    if (!pending) {
      return reply.code(404).send({ ok: false, error: "No pending plan approval for this request" });
    }
    pending.reject(new Error("User cancelled the plan"));
    pendingApprovals.delete(requestId);
    return { ok: true };
  });

  // ── Answer a clarifying question (ask_user tool) ─────────────
  fastify.post("/answer/:requestId", async (request, reply) => {
    setCors(reply);
    const { requestId } = request.params;
    const pending = pendingQuestions.get(requestId);
    if (!pending) {
      return reply.code(404).send({ ok: false, error: "No pending question for this request" });
    }
    const body = await parseIncomingPayload(request).catch(() => ({}));
    const answer = String(body?.answer ?? "").trim();
    pending.resolve(answer || "(user submitted an empty answer)");
    return { ok: true };
  });

  // ── Compact conversation ─────────────────────────────────────
  // Returns a plain-text summary of the session messages so the UI can
  // replace its message list with a compact placeholder.
  fastify.post("/compact", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    try {
      const body      = await parseIncomingPayload(request);
      const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : null;
      if (!sessionId) return reply.code(400).send({ ok: false, error: "session_id required" });

      const messages = getSessionMessages(sessionId, authSession.user_id);
      if (!messages.length) return { ok: true, summary: "(empty conversation)", messageCount: 0 };

      // Real compaction (Claude Code approach): LLM-summarize the WHOLE
      // transcript so long sessions keep their decisions, not just their tail.
      const transcript = messages.map((m) => {
        const role    = m.role === "user" ? "User" : "Assistant";
        const snippet = String(m.content || "").replace(/\s+/g, " ").slice(0, 600);
        return `${role}: ${snippet}`;
      }).join("\n").slice(-40_000);

      let summary;
      try {
        const settings   = await loadSettings(authSession.user_id);
        const modelRoute = routeModel(settings, false);
        // Don't let an unconfigured user's compaction silently fall through to
        // llm.mjs's global-file/env-var fallback (another user's key) — treat
        // "no settings" the same as a failed call and use the tail fallback.
        if (!modelRoute.ok) throw new Error("No model configured for this user");
        const { callLLM } = await import("../services/llm.mjs");
        const result = await callLLM({
          system: "Summarize this coding-session conversation for context compaction. Keep: what the user is building, decisions made, files created/edited, current state, unresolved issues, and user preferences. Omit pleasantries. Max 40 lines.",
          messages: [{ role: "user", content: transcript }],
          modelRoute,
          maxTokens: 1200,
          temperature: 0.2,
          thinking: false, // factual summarization, not reasoning
        });
        const llmSummary = String(result?.content || "").trim();
        if (!llmSummary) throw new Error("empty summary");
        summary = `[Compacted — ${messages.length} messages summarized]\n\n${llmSummary}`;
      } catch (err) {
        // Fallback: condensed tail (old behaviour) if the LLM call fails
        console.warn("[Compact] LLM summarization failed, using tail fallback:", err.message);
        const tail = messages.slice(-20).map((m) => {
          const role = m.role === "user" ? "User" : "Assistant";
          return `${role}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 400)}`;
        }).join("\n\n");
        summary = `[Compacted — ${messages.length} messages in this conversation]\n\nRecent context:\n${tail}`;
      }

      return { ok: true, summary, messageCount: messages.length };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: "Failed to compact", details: err.message });
    }
  });
}
