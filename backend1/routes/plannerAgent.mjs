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
import { loadAttachmentsFromPaths }    from "../services/attachments.service.mjs";
import { detectLanguage }              from "../services/intent.service.mjs";
import { streamPlanSummary }           from "../services/response.service.mjs";
import { PLANS_DIR, OPENAI_API_KEY, OPENAI_BASE_URL, WHISPER_MODEL, openai } from "../config/openai.mjs";
import { uniq }                        from "../utils/text.util.mjs";
import { undoRequestChanges }          from "../services/undo.service.mjs";
import { routeModel, getCapabilities } from "../services/modelRouter.mjs";
import db                              from "../db.mjs";

// ★ LangGraph runner + working-set memory
import { runKodoGraph } from "../services/graph_runner.mjs";
import {
  getLastTouchedFile,
  recordFilesTouched,
  buildWorkingSetContext,
} from "../services/workingset.mjs";
import { loadMemoryIndex, writeAgentMemory } from "../services/agentMemory.mjs";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");
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

// ── Helpers ───────────────────────────────────────────────────

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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
  if (userMessage.trim())           rememberUserMessage(sessionId, userId, userMessage.trim());
  if (attachmentPaths.length)       rememberFiles(sessionId, userId, attachmentPaths);
  if (assistantMessage.trim())      rememberAssistantMessage(sessionId, userId, assistantMessage.trim());
  if (task || taskType || projectScope) rememberTask(sessionId, userId, { task, taskType, projectScope });
  if (targetFile.trim())            rememberTargetFile(sessionId, targetFile.trim());
}

// ── Slash commands (Claude Code approach: /init, /memory, /skills, /help) ────

async function handleSlashCommand(message, { workspacePath, modelRoute }) {
  const m = String(message || "").trim();
  if (!m.startsWith("/")) return null;
  const [cmdRaw, ...rest] = m.slice(1).split(/\s+/);
  const cmd = (cmdRaw || "").toLowerCase();

  const { loadSkillIndex, walkWorkspace } = await import("../agents/nodes/agent_loop.mjs");
  const { listMemoryTopics, loadMemoryIndex: loadMemIdx } = await import("../services/agentMemory.mjs");
  const { callLLM } = await import("../services/llm.mjs");

  switch (cmd) {
    case "help":
      return [
        "**Kodo commands**",
        "- `/init` — analyse the workspace and generate KODO.md (project instructions loaded into every request)",
        "- `/memory` — show what Kodo remembers about this project",
        "- `/skills` — list available expert skills",
        "- `/help` — this list",
        "",
        "Anything else you type goes to the agent. Say `remember: <fact>` to save a fact, `forget all memory` to wipe memory.",
      ].join("\n");

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

    case "init": {
      const tree = await walkWorkspace(workspacePath, 6);
      const snapshot = tree.slice(0, 250).map((f) => (f.isDir ? `${f.path}/` : f.path)).join("\n");
      const pkgs = [];
      for (const f of tree) {
        if (!f.isDir && f.path.endsWith("package.json") && f.path.split("/").length <= 3) {
          try { pkgs.push(`--- ${f.path} ---\n${(await fs.readFile(path.join(workspacePath, f.path), "utf-8")).slice(0, 1500)}`); } catch {}
        }
      }
      const result = await callLLM({
        system: `You write KODO.md files — concise project instructions an AI coding agent loads on every request. Cover: what the project is, layout (which dir is which app), how to run/build/typecheck each part, code conventions visible from the structure, and any gotchas. Max ~120 lines of markdown. No filler.`,
        messages: [{ role: "user", content: `File tree:\n${snapshot}\n\n${pkgs.join("\n\n")}\n\nWrite the KODO.md content now (markdown only).` }],
        modelRoute,
        maxTokens: 2500,
        temperature: 0.2,
      });
      const content = String(result?.content || "").replace(/^```(?:markdown|md)?\n?/, "").replace(/\n?```\s*$/, "").trim();
      if (!content) return "Could not generate KODO.md — the model returned nothing. Try again.";
      await fs.writeFile(path.join(workspacePath, "KODO.md"), content + "\n", "utf-8");
      return `Created **KODO.md** (${content.split("\n").length} lines). It now loads into every agent request. Edit it any time — it's your project's standing instructions.\n\n${content.slice(0, 1200)}${content.length > 1200 ? "\n…" : ""}`;
    }

    default:
      return `Unknown command \`/${cmd}\`. Try \`/help\`.`;
  }
}

// ── Route ──────────────────────────────────────────────────────

export default async function plannerAgentRoute(fastify) {

  fastify.get("/capabilities", async (request, reply) => {
    setCors(reply);
    const settings = await loadSettings();
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

    const settings       = await loadSettings();
    const hasAttachments = attachment_paths.length > 0;
    const modelRoute     = routeModel(settings, hasAttachments);

    if (!modelRoute.ok) {
      const errorMap = {
        no_config:        { error: "not_configured",   action: "open_settings" },
        no_vision:        { error: "no_vision_model",  action: "open_settings" },
        model_no_vision:  { error: "model_no_vision",  action: "open_settings" },
      };
      const mapped = errorMap[modelRoute.error] || { error: modelRoute.error };
      return reply.code(400).send({ ok: false, message: modelRoute.message, ...mapped });
    }

    const effectiveMessage = message
      || (attachment_paths.length ? "Please analyse the uploaded attachment(s)." : "");

    if (!effectiveMessage) {
      return reply.code(400).send({ ok: false, error: "Message is required" });
    }

    const sessionId = session_id
      || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // ★ Memory: read DB memory + working-set of recent files
    const memory            = getMemory(sessionId, userId);
    const workingSetContext = buildWorkingSetContext(sessionId);
    const memoryContext     = buildMemoryContext(memory, workingSetContext);

    // ★ Agent memory: file-based cross-session knowledge (MEMORY.md index)
    const agentMemoryIndex  = await loadMemoryIndex(workspacePath);

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

    // Always include the "Conversation memory:" label so the cleanMessage split
    // in agentic_explore / plan_changes reliably strips everything below it —
    // including the "Agent memory:" section whose filenames would otherwise
    // pollute the name-match fast-path word list.
    const plannerContextMessage = [
      effectiveMessage,
      `Conversation memory:\n${memoryContext || "(none)"}`,
      agentMemoryIndex  ? `Agent memory:\n${agentMemoryIndex}`          : "",
    ].filter(Boolean).join("\n\n");

    // ── Concurrent-request queue ──────────────────────────────────────────────
    // Two parallel graph runs for the same session would corrupt each other's
    // file edits, so register this request's place in line now (synchronous —
    // preserves arrival order); the actual wait happens further down, after the
    // SSE stream is open and can tell the client it's queued.
    const { prevTail: sessionSlotPrevTail, release: releaseSessionSlot, hadToWait: sessionSlotQueued } = registerSessionSlot(sessionId);

    const sessionLabel = normalizeSessionLabel(message, []);
    createSession(sessionId, userId, sessionLabel);
    saveMessage(sessionId, userId, "user", effectiveMessage);
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

    reply.raw.write(`data: ${JSON.stringify({
      type:       "start",
      id:         msgId,
      session_id: sessionId,
      request_id: requestId,
      createdAt:  timestamp,
      metadata:   { intent: "graph", ...modelMeta },
    })}\n\n`);

    let contentEmitted = false;
    const collectedFileDiffs = [];
    function emit(event) {
      try {
        if (!reply.raw.writableEnded) {
          if (event.type === "content") contentEmitted = true;
          if (event.type === "file_diff") {
            collectedFileDiffs.push({
              action: event.action, path: event.path,
              language: event.language, hunks: event.hunks,
            });
          }
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (e) {
        console.warn("[SSE emit] write error:", e.message);
      }
    }

    // Now that the SSE stream is open, wait for our turn if a previous request
    // for this session is still running — the client sees a "queued" progress
    // event instead of dead air (or, as before, a hard 409 rejection).
    if (sessionSlotQueued) {
      emit({ type: "progress", stage: "queued", message: "⏳ Waiting for a previous request in this session to finish..." });
    }
    await sessionSlotPrevTail.catch(() => {}); // don't let a prior failure jam the queue

    // ── Slash commands: handled without touching the graph ───────────────────
    if (effectiveMessage.startsWith("/")) {
      try {
        const slashReply = await handleSlashCommand(effectiveMessage, { workspacePath, modelRoute });
        if (slashReply) {
          emit({ type: "content", content: slashReply });
          emit({ type: "done", request_id: requestId, summary: slashReply, metadata: { type: "command", request_id: requestId, ...modelMeta } });
          reply.raw.end();
          saveMessage(sessionId, userId, "assistant", slashReply, "command");
          touchSession(sessionId, userId);
          releaseSessionSlot();
          return reply;
        }
      } catch (err) {
        const msg = `Command failed: ${err.message}`;
        emit({ type: "content", content: msg });
        emit({ type: "done", request_id: requestId, summary: msg, metadata: { type: "command", request_id: requestId, ...modelMeta } });
        reply.raw.end();
        releaseSessionSlot();
        return reply;
      }
    }

    // ── Run the LangGraph (with hard timeout so SSE always closes) ───────────
    const GRAPH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes max

    // Client disconnect handling
    const controller = new AbortController();
    const abortListener = () => controller.abort();
    request.raw.on("close", abortListener);

    let finalAnswer = "";
    let editedFiles = [];

    // In "ask" mode create a promise that execute_changes awaits before writing files.
    // It resolves when POST /confirm/:requestId arrives, rejects on POST /reject/:requestId.
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
      // Prevent unhandled rejection crash if the graph finishes without ever awaiting this
      // (e.g. intent routed to "answer" instead of "explore"). The rejection is handled
      // internally when runKodoGraph awaits it; this suppresses the dangling-promise crash.
      approvalPromise.catch(() => {});
    }

    const graphPromise = runKodoGraph({
      userMessage:          plannerContextMessage,
      rememberedTargetFile: rememberedFile,
      sessionId,
      requestId,
      userId,
      workspacePath,
      modelRoute,
      attachmentPaths: attachment_paths,
      emit,
      abortSignal: controller.signal,
      permissionMode,
      approvalPromise,
    }).then(r => ({ ok: true, result: r })).catch(e => ({ ok: false, error: e }));

    const timeoutPromise = new Promise(resolve =>
      setTimeout(() => resolve({ ok: false, timedOut: true }), GRAPH_TIMEOUT_MS)
    );

    const raceResult = await Promise.race([graphPromise, timeoutPromise]);

    // Always clean up so the 5-min timer can't fire after this handler exits
    // and crash the process with an unhandled rejection.
    if (approvalTimeoutId !== null) clearTimeout(approvalTimeoutId);
    pendingApprovals.delete(requestId);

    if (raceResult.timedOut) {
      console.warn("[Agent] ⏱️ Graph timeout — closing SSE stream");
      releaseSessionSlot();
      emit({ type: "content", content: "The task is taking longer than expected. Please try again." });
      emit({ type: "done", request_id: requestId, summary: "",
             metadata: { type: "graph", request_id: requestId, ...modelMeta } });
      reply.raw.end();
      return reply;
    }

    if (!raceResult.ok) {
      const graphError = raceResult.error;
      console.error("❌ LangGraph error:", graphError);
      releaseSessionSlot();
      emit({ type: "error", error: "Graph execution failed", details: graphError.message });
      reply.raw.end();
      saveMessage(sessionId, userId, "assistant", `Error: ${graphError.message}`, "error");
      touchSession(sessionId, userId);
      syncSessionMemory(sessionId, userId, { assistantMessage: `Error: ${graphError.message}` });
      return reply;
    }

    finalAnswer = raceResult.result.finalAnswer || "";
    editedFiles  = raceResult.result.editedFiles  || [];
    const usage  = raceResult.result.usage || null;

    // ── Done ──────────────────────────────────────────────────
    // The answer node streams content chunks during execution (contentEmitted=true).
    // Explore/plan paths never emit content events — emit finalAnswer now so the
    // UI message is never left empty (which causes "Running agent…" to persist).
    if (finalAnswer && !contentEmitted) {
      emit({ type: "content", content: finalAnswer });
    }

    emit({
      type:     "done",
      request_id: requestId,
      summary:  finalAnswer,
      metadata: {
        type:       "graph",
        request_id: requestId,
        ...modelMeta,
        ...(usage ? { usage } : {}),
      },
    });

    reply.raw.end();

    saveMessage(
      sessionId, userId, "assistant", finalAnswer || "(no output)", "graph",
      requestId,
      collectedFileDiffs.length > 0 ? collectedFileDiffs : null,
    );
    touchSession(sessionId, userId);

    // ★ Memory: record which files were edited this turn
    if (editedFiles.length > 0) {
      recordFilesTouched(sessionId, editedFiles, effectiveMessage.slice(0, 80));
      console.log(`[Memory] 📝 Recorded ${editedFiles.length} edited file(s): ${editedFiles.join(", ")}`);
    }

    // ★ Agent memory: fire-and-forget LLM-driven write to .kodo/memory/
    // Only run when the explore/edit pipeline actually did something — skip pure Q&A answers
    // to avoid a wasted LLM call on every chat message.
    const isRememberCommand = /^remember[:\s]/i.test(effectiveMessage);
    const shouldWriteMemory = finalAnswer && (editedFiles.length > 0 || String(effectiveMessage).length > 60 || isRememberCommand);
    if (shouldWriteMemory) {
      writeAgentMemory({
        workspacePath,
        userMessage:     effectiveMessage,
        assistantAnswer: finalAnswer,
        editedFiles,
        modelRoute,
      }).catch(err => console.warn("[AgentMemory] background write failed:", err.message));
    }

        syncSessionMemory(sessionId, userId, {
      assistantMessage: finalAnswer,
      task:             effectiveMessage,
      taskType:         "graph",
      targetFile:       editedFiles[0] || "",
    });

    // Release session lock and cleanup abort listener
    releaseSessionSlot();
    request.raw.removeListener("close", abortListener);

    return reply;
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

  fastify.delete("/sessions/:sessionId", async (request, reply) => {
    setCors(reply);
    const authSession = requireUserSession(request, reply);
    if (!authSession) return;
    try {
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
        const settings   = await loadSettings();
        const modelRoute = routeModel(settings, false);
        const { callLLM } = await import("../services/llm.mjs");
        const result = await callLLM({
          system: "Summarize this coding-session conversation for context compaction. Keep: what the user is building, decisions made, files created/edited, current state, unresolved issues, and user preferences. Omit pleasantries. Max 40 lines.",
          messages: [{ role: "user", content: transcript }],
          modelRoute,
          maxTokens: 1200,
          temperature: 0.2,
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
