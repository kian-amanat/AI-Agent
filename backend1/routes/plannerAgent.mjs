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

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

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
  reply.raw.setHeader("Access-Control-Allow-Origin", "*");
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
  reply.header("Access-Control-Allow-Origin", "*");
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
  if (targetFile.trim())            rememberTargetFile(sessionId, userId, targetFile.trim());
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

    const plannerContextMessage = [
      effectiveMessage,
      memoryContext ? `Conversation memory:\n${memoryContext}` : "",
    ].filter(Boolean).join("\n\n");

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

    function emit(event) {
      try {
        if (!reply.raw.writableEnded) {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (e) {
        console.warn("[SSE emit] write error:", e.message);
      }
    }

    // ── Run the LangGraph ─────────────────────────────────────
    let finalAnswer = "";
    let editedFiles = [];

    try {
      const result = await runKodoGraph({
        userMessage:          plannerContextMessage,
        rememberedTargetFile: rememberedFile,   // ★ memory in
        sessionId,
        requestId,
        userId,
        workspacePath,
        modelRoute,
        attachmentPaths: attachment_paths,
        emit,
      });

      finalAnswer = result.finalAnswer || "";
      editedFiles = result.editedFiles || [];   // ★ files out
    } catch (graphError) {
      console.error("❌ LangGraph error:", graphError);

      emit({ type: "error", error: "Graph execution failed", details: graphError.message });
      reply.raw.end();

      saveMessage(sessionId, userId, "assistant", `Error: ${graphError.message}`, "error");
      touchSession(sessionId, userId);
      syncSessionMemory(sessionId, userId, { assistantMessage: `Error: ${graphError.message}` });
      return reply;
    }

    // ── Done ──────────────────────────────────────────────────
    if (finalAnswer) {
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
      },
    });

    reply.raw.end();

    saveMessage(sessionId, userId, "assistant", finalAnswer || "(no output)", "graph");
    touchSession(sessionId, userId);

    // ★ Memory: record which files were edited this turn
    if (editedFiles.length > 0) {
      recordFilesTouched(sessionId, editedFiles, effectiveMessage.slice(0, 80));
      console.log(`[Memory] 📝 Recorded ${editedFiles.length} edited file(s): ${editedFiles.join(", ")}`);
    }

    syncSessionMemory(sessionId, userId, {
      assistantMessage: finalAnswer,
      task:             effectiveMessage,
      taskType:         "graph",
      targetFile:       editedFiles[0] || "",
    });

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
}
