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
import { parseIncomingPayload } from "../utils/request.util.mjs";
import { loadAttachmentsFromPaths } from "../services/attachments.service.mjs";
import { classifyIntent, detectLanguage } from "../services/intent.service.mjs";
import {
  generateGreetingResponse,
  generateInspectionResponse,
  generateCodeResponse,
  generateClarificationResponse,
  generateCasualResponse,
  streamPlanSummary,
} from "../services/response.service.mjs";
import { runPipeline } from "../services/pipeline.service.mjs";
import {
  PLANS_DIR,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  WHISPER_MODEL,
  openai,
} from "../config/openai.mjs";
import { uniq } from "../utils/text.util.mjs";
import { undoRequestChanges } from "../services/undo.service.mjs";

// [KODO] Smart model routing
import { routeModel, getCapabilities } from "../services/modelRouter.mjs";

// [KODO] Auth db — to read workspace_path from the authenticated session
import db from "../db.mjs";

const FILE_AGENT_SCRIPT = path.resolve(process.cwd(), "../file_agent.mjs");

// [KODO] Settings loader
const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// [KODO] Read the workspace path bound by the VS Code extension from the auth session.
// Returns empty string if the request has no valid token or no workspace is bound.
function getWorkspaceFromRequest(request) {
  try {
    const auth = request.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) return "";

    const token = auth.slice(7);
    const session = db
      .prepare("SELECT workspace_path FROM auth_sessions WHERE token = ?")
      .get(token);

    const wp = session?.workspace_path || "";
    if (wp) console.log(`[Kodo] 📁 Workspace from auth session: ${wp}`);
    return wp;
  } catch {
    return "";
  }
}

function startSSE(reply) {
  reply.raw.setHeader("Access-Control-Allow-Origin", "*");
  reply.raw.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
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
    return value
      .map((item) => (typeof item === "string" ? item : item?.path))
      .filter((item) => typeof item === "string" && item.trim());
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === "string" && item.trim());
      }
    } catch {
      // ignore JSON parsing errors
    }

    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}

function extractCandidateFilePaths(message) {
  const msg = String(message || "");

  const pathRegex =
    /(?:\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js))/g;

  const filenameRegex =
    /\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js)\b/g;

  const matches = uniq([
    ...(msg.match(pathRegex) || []),
    ...(msg.match(filenameRegex) || []),
  ]);

  return matches.map((item) => String(item || "").trim()).filter(Boolean);
}

function previewText(value, maxChars = 140) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildMemoryContext(memory) {
  if (!memory) return "";

  const lines = [];

  if (memory.last_task) lines.push(`LAST TASK: ${memory.last_task}`);
  if (memory.last_task_type) lines.push(`LAST TASK TYPE: ${memory.last_task_type}`);
  if (memory.last_project_scope) {
    lines.push(`LAST PROJECT SCOPE: ${memory.last_project_scope}`);
  }

  if (memory.last_target_file) {
    lines.push(`LAST TARGET FILE: ${memory.last_target_file}`);
  }

  if (memory.last_target_component) {
    lines.push(`LAST TARGET COMPONENT: ${memory.last_target_component}`);
  }

  if (Array.isArray(memory.last_attachment_paths) && memory.last_attachment_paths.length) {
    lines.push(`LAST ATTACHMENTS: ${memory.last_attachment_paths.join(", ")}`);
  }

  if (memory.last_user_message) {
    lines.push(`LAST USER MESSAGE: ${previewText(memory.last_user_message)}`);
  }

  if (memory.last_assistant_message) {
    lines.push(`LAST ASSISTANT MESSAGE: ${previewText(memory.last_assistant_message)}`);
  }

  return lines.join("\n").trim();
}

function syncSessionMemory(sessionId, {
  userMessage = "",
  assistantMessage = "",
  attachmentPaths = [],
  task = "",
  taskType = "",
  projectScope = "",
  targetFile = "",
} = {}) {
  if (!sessionId) return;

  if (typeof userMessage === "string" && userMessage.trim()) {
    rememberUserMessage(sessionId, userMessage.trim());
  }

  if (Array.isArray(attachmentPaths) && attachmentPaths.length > 0) {
    rememberFiles(sessionId, attachmentPaths);
  }

  if (typeof assistantMessage === "string" && assistantMessage.trim()) {
    rememberAssistantMessage(sessionId, assistantMessage.trim());
  }

  if (task || taskType || projectScope) {
    rememberTask(sessionId, {
      task: task || null,
      taskType: taskType || null,
      projectScope: projectScope || null,
    });
  }

  if (typeof targetFile === "string" && targetFile.trim()) {
    rememberTargetFile(sessionId, targetFile.trim());
  }
}

function extractPrimaryTargetFile(plan) {
  if (Array.isArray(plan?.target_files) && plan.target_files.length > 0) {
    return String(plan.target_files[0] || "").trim();
  }

  if (Array.isArray(plan?.files_to_modify)) {
    const firstModify = plan.files_to_modify.find((item) => item?.path);
    if (firstModify?.path) return String(firstModify.path).trim();
  }

  if (Array.isArray(plan?.files_to_create)) {
    const firstCreate = plan.files_to_create.find((item) => item?.path);
    if (firstCreate?.path) return String(firstCreate.path).trim();
  }

  return "";
}

function parseFileAgentOutput(output) {
  const marker = "[Structured_File_Analysis_JSON]";
  const idx = output.lastIndexOf(marker);

  if (idx === -1) {
    return { rawText: output.trim(), structured: null };
  }

  const rawText = output.slice(0, idx).trim();
  const jsonText = output.slice(idx + marker.length).trim();

  try {
    return { rawText, structured: JSON.parse(jsonText) };
  } catch {
    return { rawText, structured: null };
  }
}

function buildFileAnalysisContext(fileAnalysis) {
  if (!fileAnalysis?.files || !Array.isArray(fileAnalysis.files)) return "";

  const lines = [];

  for (const file of fileAnalysis.files) {
    lines.push(`FILE: ${file.file || "unknown"}`);
    lines.push(`TYPE: ${file.fileType || "unknown"}`);

    if (file.natural_summary) {
      lines.push(`SUMMARY: ${file.natural_summary}`);
    }

    const structured = file.structured;
    if (structured) {
      if (structured.detected_kind) {
        lines.push(`KIND: ${structured.detected_kind}`);
      }
      if (Array.isArray(structured.key_elements) && structured.key_elements.length > 0) {
        lines.push(`KEY ELEMENTS: ${structured.key_elements.slice(0, 6).join(", ")}`);
      }
      if (Array.isArray(structured.possible_tasks) && structured.possible_tasks.length > 0) {
        lines.push(`POSSIBLE TASKS: ${structured.possible_tasks.slice(0, 6).join(", ")}`);
      }
      if (Array.isArray(structured.domain_entities) && structured.domain_entities.length > 0) {
        lines.push(`DOMAIN ENTITIES: ${structured.domain_entities.slice(0, 6).join(", ")}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

function runFileAgent({ files, userMessage = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [FILE_AGENT_SCRIPT, JSON.stringify({ files, userMessage })],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "1" },
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(parseFileAgentOutput(stdout));
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `file_agent exited with code ${code}`));
      }
    });

    child.on("error", (error) => { reject(error); });
  });
}

async function transcribeAudio(audioPath) {
  console.log("🎙️ Using Whisper model:", WHISPER_MODEL);
  console.log("📡 Base URL:", OPENAI_BASE_URL);

  try {
    const response = await openai.audio.transcriptions.create({
      model: WHISPER_MODEL || "gapgpt/whisper-1",
      file: createReadStream(audioPath),
    });

    console.log("📥 Whisper SDK response:", response);

    const text = (response.text || "").trim();
    if (!text) throw new Error("Empty transcription text returned from Whisper");

    return text;
  } catch (err) {
    console.error("❌ Whisper transcription error via SDK:", err);

    if (err?.code === "api_limit" || err?.status === 429) {
      throw new Error("Whisper API rate limit reached (429). Please wait or check your GapGPT plan/quota.");
    }

    const apiError = err?.error || err?.response || err;
    throw new Error(`Whisper transcription failed via SDK: ${apiError?.message || String(apiError)}`);
  }
}

export default async function plannerAgentRoute(fastify) {

  // [KODO] Capabilities endpoint — frontend checks this on load
  fastify.get("/capabilities", async (request, reply) => {
    setCors(reply);
    const settings = await loadSettings();
    return { ok: true, ...getCapabilities(settings) };
  });

  fastify.post("/run", async (request, reply) => {
    setCors(reply);

    const body = await parseIncomingPayload(request);

    const message =
      typeof body.message === "string" ? body.message.trim()
      : typeof body.text === "string" ? body.text.trim()
      : typeof body.prompt === "string" ? body.prompt.trim()
      : "";

    const session_id =
      typeof body.session_id === "string" && body.session_id.trim()
        ? body.session_id.trim()
        : "";

    const attachment_paths = uniq([
      ...toStringArray(body.attachment_paths),
      ...toStringArray(body.attachments),
      ...toStringArray(body.files),
    ]);

    // [KODO] Get the workspace path bound by the VS Code extension.
    // Falls back to empty string if no auth token or no workspace bound.
    const workspacePath = getWorkspaceFromRequest(request);

    console.log("BODY RECEIVED =>", body);
    console.log("MESSAGE =>", message);
    console.log("ATTACHMENT PATHS =>", attachment_paths);
    console.log("WORKSPACE PATH =>", workspacePath || "(not set — will use pipeline default)");

    // [KODO] Smart model routing
    const settings = await loadSettings();
    const hasAttachments = attachment_paths.length > 0;
    const modelRoute = routeModel(settings, hasAttachments);

    if (!modelRoute.ok && modelRoute.error === "no_config") {
      return reply.code(400).send({
        ok: false,
        error: "not_configured",
        message: modelRoute.message,
        action: "open_settings",
      });
    }

    if (!modelRoute.ok && modelRoute.error === "no_vision") {
      return reply.code(400).send({
        ok: false,
        error: "no_vision_model",
        message: modelRoute.message,
        action: "open_settings",
      });
    }

    if (!modelRoute.ok && modelRoute.error === "model_no_vision") {
      return reply.code(400).send({
        ok: false,
        error: "model_no_vision",
        message: modelRoute.message,
        action: "open_settings",
      });
    }

    if (modelRoute.switchedModel) {
      console.log(`[Kodo] 🔄 Auto-switched: ${modelRoute.switchedFrom} → ${modelRoute.switchedTo}`);
    } else {
      console.log(`[Kodo] 🤖 Using model: ${modelRoute.provider}/${modelRoute.model}`);
    }

    const attachments = attachment_paths.length
      ? await loadAttachmentsFromPaths(attachment_paths)
      : [];

    const sessionId =
      typeof session_id === "string" && session_id.trim()
        ? session_id.trim()
        : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const memory = getMemory(sessionId);
    const memoryContext = buildMemoryContext(memory);

    let fileAnalysisContext = "";
    if (attachment_paths.length > 0) {
      try {
        const fileAnalysis = await runFileAgent({ files: attachment_paths, userMessage: message });
        fileAnalysisContext = buildFileAnalysisContext(fileAnalysis);
      } catch (error) {
        console.warn("⚠️ File analysis agent failed:", error.message);
      }
    }

    const effectiveMessage =
      message || (attachments.length ? "Please analyze the uploaded attachment(s)." : "");

    if (!effectiveMessage) {
      return reply.code(400).send({ ok: false, error: "Message is required and must be a string" });
    }

    const explicitFileRefs = extractCandidateFilePaths(message);
    const rememberedTargetFile =
      !explicitFileRefs.length && memory?.last_target_file
        ? String(memory.last_target_file).trim()
        : "";

    const plannerContextMessage = [
      effectiveMessage,
      memoryContext ? `Conversation memory:\n${memoryContext}` : "",
      rememberedTargetFile ? `Remembered target file:\n${rememberedTargetFile}` : "",
      fileAnalysisContext ? `Uploaded file context:\n${fileAnalysisContext}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const sessionLabel = normalizeSessionLabel(message, attachments);

    createSession(sessionId, sessionLabel);
    saveMessage(sessionId, "user", effectiveMessage);
    touchSession(sessionId);

    syncSessionMemory(sessionId, {
      userMessage: effectiveMessage,
      attachmentPaths: attachment_paths,
    });

    try {
      const intent = classifyIntent(plannerContextMessage, attachments);
      console.log(`📊 Intent: ${intent.type}`);

      const msgId = `msg_${Date.now()}`;
      const timestamp = new Date().toISOString();
      const lang = detectLanguage(plannerContextMessage);

      // [KODO] Model metadata for SSE events
      const modelMeta = {
        model: modelRoute.model,
        provider: modelRoute.provider,
        switchedModel: modelRoute.switchedModel || false,
        switchedFrom: modelRoute.switchedFrom || null,
        switchedTo: modelRoute.switchedTo || null,
      };

      if (intent.type === "crisis") {
        startSSE(reply);
        const content =
          lang === "en"
            ? "💙 I hear you, and I'm really glad you reached out. Please talk to someone who can help right now:\n\n• **Iran Crisis Line:** ☎️ 1480\n• **International:** https://findahelpline.com\n\nYou don't have to go through this alone. 💙"
            : "💙 می‌فهمم که الان خیلی سخته. لطفاً همین الان با یه متخصص صحبت کن:\n\n• **اورژانس اجتماعی ایران:** ☎️ ۱۲۳\n• **خط بحران:** ☎️ ۱۴۸۰\n\nتنها نیستی. 💙";

        reply.raw.write(`data: ${JSON.stringify({ type: "start", id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: "crisis", ...modelMeta } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "crisis" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "crisis");
        touchSession(sessionId);
        syncSessionMemory(sessionId, { assistantMessage: content });
        return reply;
      }

      if (intent.type === "inspection") {
        startSSE(reply);
        const content = await generateInspectionResponse(
          plannerContextMessage,
          attachments,
          sessionId,
          modelRoute
        );

        reply.raw.write(`data: ${JSON.stringify({ type: "start", id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: "inspection", ...modelMeta } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "inspection" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "inspection");
        touchSession(sessionId);
        syncSessionMemory(sessionId, { assistantMessage: content });
        return reply;
      }

      if (intent.type === "code_request") {
        startSSE(reply);
        const content = await generateCodeResponse(
          plannerContextMessage,
          attachments,
          sessionId,
          modelRoute
        );

        reply.raw.write(`data: ${JSON.stringify({ type: "start", id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: "code_request", ...modelMeta } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "code_request" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "code_request");
        touchSession(sessionId);
        syncSessionMemory(sessionId, { assistantMessage: content, targetFile: rememberedTargetFile });
        return reply;
      }

      if (intent.type === "greeting") {
        startSSE(reply);
        const content = await generateGreetingResponse(
          effectiveMessage,
          sessionId,
          modelRoute
        );

        reply.raw.write(`data: ${JSON.stringify({ type: "start", id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: "greeting", ...modelMeta } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "greeting" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "greeting");
        touchSession(sessionId);
        syncSessionMemory(sessionId, { assistantMessage: content });
        return reply;
      }

      if (intent.type === "clarification") {
        startSSE(reply);
        const content = await generateClarificationResponse(
          effectiveMessage,
          modelRoute
        );

        reply.raw.write(`data: ${JSON.stringify({ type: "start", id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: "clarification", ...modelMeta } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "clarification" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "clarification");
        touchSession(sessionId);
        syncSessionMemory(sessionId, { assistantMessage: content });
        return reply;
      }

      if (intent.type === "technical") {
        startSSE(reply);

        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        console.log("[AGENT /run] pipeline call", { sessionId, requestId, workspacePath });

        reply.raw.write(`data: ${JSON.stringify({ type: "start", id: msgId, session_id: sessionId, request_id: requestId, createdAt: timestamp, metadata: { intent: intent.type, ...modelMeta } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "progress", stage: "pipeline_start", message: lang === "en" ? "🚀 Starting full development pipeline..." : "🚀 شروع پایپلاین کامل توسعه..." })}\n\n`);

        if (modelRoute.switchedModel) {
          reply.raw.write(`data: ${JSON.stringify({ type: "progress", stage: "model_switch", message: `🔄 Switched to ${modelRoute.switchedTo} for file analysis` })}\n\n`);
        }

        reply.raw.write(`data: ${JSON.stringify({ type: "progress", stage: "planning", message: lang === "en" ? "📋 Phase 1/5: Planning architecture..." : "📋 فاز 1/5: طراحی معماری..." })}\n\n`);

        try {
          // [KODO] Pass workspacePath so pipeline writes to the correct project
          await runPipeline({
            message: plannerContextMessage,
            sessionId,
            requestId,
            attachmentPaths: attachment_paths,
            audioPath: "",
            workspacePath,
          });
        } catch (pipelineError) {
          reply.raw.write(`data: ${JSON.stringify({ type: "error", error: "Pipeline execution failed", details: pipelineError.message, request_id: requestId })}\n\n`);
          reply.raw.end();

          saveMessage(sessionId, "assistant", `Pipeline failed: ${pipelineError.message}`, "technical");
          touchSession(sessionId);
          syncSessionMemory(sessionId, {
            assistantMessage: `Pipeline failed: ${pipelineError.message}`,
            task: effectiveMessage,
            taskType: intent.type,
            projectScope: "technical",
            targetFile: rememberedTargetFile,
          });
          return reply;
        }

        reply.raw.write(`data: ${JSON.stringify({ type: "progress", stage: "completed", message: lang === "en" ? "✅ All phases completed! Preparing summary..." : "✅ همه فازها تکمیل شد! آماده‌سازی خلاصه..." })}\n\n`);

        const plannerPlanPath = path.resolve(PLANS_DIR, "planner_plan.json");
        let plan = {};
        const latestPlan = "planner_plan.json";

        try {
          plan = JSON.parse(await fs.readFile(plannerPlanPath, "utf-8"));
        } catch (err) {
          console.warn("⚠️  Could not read planner_plan.json:", err.message);
        }

        reply.raw.write(`data: ${JSON.stringify({ type: "plan_metadata", plan_file: latestPlan, plan_path: plannerPlanPath, phases_count: plan.phases?.length || 0, files_count: plan.files?.length || 0, tech_stack: plan.tech_stack || {} })}\n\n`);

        const summary = await streamPlanSummary(plan, plannerContextMessage, reply, modelRoute);

        reply.raw.write(`data: ${JSON.stringify({ type: "done", summary, metadata: { type: "pipeline", intent: intent.type, plan_file: latestPlan, plan_path: plannerPlanPath, plan_summary: { name: plan.name, project_type: plan.project_type, goal: plan.goal, tech_stack: plan.tech_stack, phases_count: plan.phases?.length || 0, files_count: plan.files?.length || 0 }, plan, full_plan_url: `/api/agent/plan/${latestPlan}`, request_id: requestId, ...modelMeta } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", summary, "technical");
        touchSession(sessionId);

        const primaryTargetFile = extractPrimaryTargetFile(plan) || rememberedTargetFile || "";

        syncSessionMemory(sessionId, {
          assistantMessage: summary,
          task: effectiveMessage,
          taskType: intent.type,
          projectScope: plan.project_type || plan.task_scope || "technical",
          targetFile: primaryTargetFile,
          attachmentPaths: attachment_paths,
        });

        return reply;
      }

      startSSE(reply);
      const content = await generateCasualResponse(effectiveMessage, modelRoute);

      reply.raw.write(`data: ${JSON.stringify({ type: "start", id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: "casual", ...modelMeta } })}\n\n`);
      reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
      reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "casual" } })}\n\n`);
      reply.raw.end();

      saveMessage(sessionId, "assistant", content, "casual");
      touchSession(sessionId);
      syncSessionMemory(sessionId, { assistantMessage: content });
      return reply;

    } catch (error) {
      console.error("❌ Error in agent route:", error);
      if (reply.raw.headersSent) {
        reply.raw.write(`data: ${JSON.stringify({ type: "error", error: "Internal server error", details: error.message })}\n\n`);
        reply.raw.end();
      } else {
        return reply.code(500).send({ ok: false, error: "Internal server error", details: error.message });
      }
    }
  });

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
      if (error.code === "ENOENT") {
        return reply.code(404).send({ ok: false, error: "Plan not found" });
      }
      return reply.code(500).send({ ok: false, error: "Failed to read plan", details: error.message });
    }
  });

  fastify.get("/sessions", async (request, reply) => {
    setCors(reply);
    try {
      const sessions = listSessions();
      return reply.send({ ok: true, sessions });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: "Failed to list sessions", details: error.message });
    }
  });

  fastify.get("/sessions/:sessionId", async (request, reply) => {
    setCors(reply);
    try {
      const messages = getSessionMessages(request.params.sessionId);
      return reply.send({ ok: true, session_id: request.params.sessionId, messages });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: "Failed to get session", details: error.message });
    }
  });

  fastify.delete("/sessions/:sessionId", async (request, reply) => {
    setCors(reply);
    try {
      deleteSession(request.params.sessionId);
      return reply.send({ ok: true, deleted: request.params.sessionId });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: "Failed to delete session", details: error.message });
    }
  });

  fastify.post("/transcribe", async (request, reply) => {
    console.log("🎙️ /transcribe hit");
    setCors(reply);

    try {
      if (typeof request.file !== "function") {
        return reply.code(400).send({ ok: false, error: "Multipart upload is not enabled. Install and register @fastify/multipart." });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ ok: false, error: "No audio file provided. Upload audio file in 'audio' field." });
      }

      const tempDir = path.join(process.cwd(), "temp_audio");
      await fs.mkdir(tempDir, { recursive: true });

      const tempAudioPath = path.join(tempDir, `audio_${Date.now()}.webm`);
      await pipeline(data.file, createWriteStream(tempAudioPath));

      const transcript = await transcribeAudio(tempAudioPath);
      await fs.unlink(tempAudioPath).catch(() => {});

      const session_id = data.fields?.session_id?.[0]?.value || "";
      const attachment_paths = uniq([
        ...toStringArray(data.fields?.attachment_paths?.[0]?.value),
        ...toStringArray(data.fields?.attachments?.[0]?.value),
        ...toStringArray(data.fields?.files?.[0]?.value),
      ]);

      return reply.send({
        ok: true,
        transcribed_text: transcript,
        session_id: session_id || undefined,
        attachment_paths: attachment_paths.length > 0 ? attachment_paths : undefined,
        message: "Audio transcribed successfully. Use the 'transcribed_text' as the message for /run endpoint.",
      });
    } catch (error) {
      console.error("❌ Transcription endpoint error:", error);

      const msg = error.message || "";
      const isRateLimit = msg.includes("rate limit") || msg.includes("429") || error.code === "api_limit";

      return reply.code(isRateLimit ? 429 : 500).send({
        ok: false,
        error: isRateLimit
          ? "Whisper API rate limit reached on GapGPT. Please try again later or check your plan/quota."
          : "Failed to transcribe audio",
        details: msg,
      });
    }
  });

  fastify.post("/undo", async (request, reply) => {
    setCors(reply);

    try {
      const body = await parseIncomingPayload(request);

      const sessionId =
        typeof body.session_id === "string" && body.session_id.trim()
          ? body.session_id.trim()
          : null;

      const requestId =
        typeof body.request_id === "string" && body.request_id.trim()
          ? body.request_id.trim()
          : null;

      if (!sessionId || !requestId) {
        return reply.code(400).send({ ok: false, error: "session_id and request_id are required" });
      }

      console.log(`🕙 Undo requested for session=${sessionId}, request=${requestId}`);

      const result = undoRequestChanges({ sessionId, requestId });

      return reply.send({ ok: true, session_id: sessionId, request_id: requestId, result });
    } catch (err) {
      console.error("❌ Error in /undo route:", err);
      return reply.code(500).send({ ok: false, error: "Failed to undo changes", details: err.message });
    }
  });
}
