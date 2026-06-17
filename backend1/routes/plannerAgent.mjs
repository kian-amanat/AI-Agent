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

const FILE_AGENT_SCRIPT = path.resolve(process.cwd(), "../file_agent.mjs");

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

function parseFileAgentOutput(output) {
  const marker = "[Structured_File_Analysis_JSON]";
  const idx = output.lastIndexOf(marker);

  if (idx === -1) {
    return {
      rawText: output.trim(),
      structured: null,
    };
  }

  const rawText = output.slice(0, idx).trim();
  const jsonText = output.slice(idx + marker.length).trim();

  try {
    return {
      rawText,
      structured: JSON.parse(jsonText),
    };
  } catch {
    return {
      rawText,
      structured: null,
    };
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
        env: {
          ...process.env,
          FORCE_COLOR: "1",
        },
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(parseFileAgentOutput(stdout));
      } else {
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `file_agent exited with code ${code}`
          )
        );
      }
    });

    child.on("error", (error) => {
      reject(error);
    });
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
    if (!text) {
      throw new Error("Empty transcription text returned from Whisper");
    }

    return text;
  } catch (err) {
    console.error("❌ Whisper transcription error via SDK:", err);

    if (err?.code === "api_limit" || err?.status === 429) {
      throw new Error(
        "Whisper API rate limit reached (429). Please wait or check your GapGPT plan/quota."
      );
    }

    const apiError = err?.error || err?.response || err;
    throw new Error(
      `Whisper transcription failed via SDK: ${
        apiError?.message || String(apiError)
      }`
    );
  }
}

export default async function plannerAgentRoute(fastify) {
  fastify.post("/run", async (request, reply) => {
    setCors(reply);

    const body = await parseIncomingPayload(request);

    const message =
      typeof body.message === "string"
        ? body.message.trim()
        : typeof body.text === "string"
          ? body.text.trim()
          : typeof body.prompt === "string"
            ? body.prompt.trim()
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

    console.log("BODY RECEIVED =>", body);
    console.log("MESSAGE =>", message);
    console.log("ATTACHMENT PATHS =>", attachment_paths);

    const attachments = attachment_paths.length
      ? await loadAttachmentsFromPaths(attachment_paths)
      : [];

    let fileAnalysisContext = "";
    if (attachment_paths.length > 0) {
      try {
        const fileAnalysis = await runFileAgent({
          files: attachment_paths,
          userMessage: message,
        });

        fileAnalysisContext = buildFileAnalysisContext(fileAnalysis);
      } catch (error) {
        console.warn("⚠️ File analysis agent failed:", error.message);
      }
    }

    const effectiveMessage =
      message || (attachments.length ? "Please analyze the uploaded attachment(s)." : "");

    const plannerContextMessage = fileAnalysisContext
      ? `${effectiveMessage}\n\nUploaded file context:\n${fileAnalysisContext}`
      : effectiveMessage;

    if (!effectiveMessage) {
      return reply.code(400).send({
        ok: false,
        error: "Message is required and must be a string",
      });
    }

    const sessionId =
      typeof session_id === "string" && session_id.trim()
        ? session_id.trim()
        : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const sessionLabel = normalizeSessionLabel(message, attachments);

    createSession(sessionId, sessionLabel);
    saveMessage(sessionId, "user", effectiveMessage);
    touchSession(sessionId);

    try {
      const intent = classifyIntent(plannerContextMessage, attachments);
      console.log(`📊 Intent: ${intent.type}`);

      const msgId = `msg_${Date.now()}`;
      const timestamp = new Date().toISOString();
      const lang = detectLanguage(plannerContextMessage);

      if (intent.type === "crisis") {
        startSSE(reply);
        const content =
          lang === "en"
            ? "💙 I hear you, and I'm really glad you reached out. Please talk to someone who can help right now:\n\n• **Iran Crisis Line:** ☎️ 1480\n• **International:** https://findahelpline.com\n\nYou don't have to go through this alone. 💙"
            : "💙 می‌فهمم که الان خیلی سخته. لطفاً همین الان با یه متخصص صحبت کن:\n\n• **اورژانس اجتماعی ایران:** ☎️ ۱۲۳\n• **خط بحران:** ☎️ ۱۴۸۰\n\nتنها نیستی. 💙";

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "start",
            id: msgId,
            session_id: sessionId,
            createdAt: timestamp,
            metadata: { intent: "crisis" },
          })}\n\n`
        );
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(
          `data: ${JSON.stringify({
            type: "done",
            metadata: { type: "crisis" },
          })}\n\n`
        );
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "crisis");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "inspection") {
        startSSE(reply);
        const content = await generateInspectionResponse(
          plannerContextMessage,
          attachments
        );

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "start",
            id: msgId,
            session_id: sessionId,
            createdAt: timestamp,
            metadata: { intent: "inspection" },
          })}\n\n`
        );
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(
          `data: ${JSON.stringify({
            type: "done",
            metadata: { type: "inspection" },
          })}\n\n`
        );
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "inspection");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "code_request") {
        startSSE(reply);
        const content = await generateCodeResponse(
          plannerContextMessage,
          attachments
        );

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "start",
            id: msgId,
            session_id: sessionId,
            createdAt: timestamp,
            metadata: { intent: "code_request" },
          })}\n\n`
        );
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(
          `data: ${JSON.stringify({
            type: "done",
            metadata: { type: "code_request" },
          })}\n\n`
        );
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "code_request");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "greeting") {
        startSSE(reply);
        const content = await generateGreetingResponse(effectiveMessage, sessionId);

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "start",
            id: msgId,
            session_id: sessionId,
            createdAt: timestamp,
            metadata: { intent: "greeting" },
          })}\n\n`
        );
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(
          `data: ${JSON.stringify({
            type: "done",
            metadata: { type: "greeting" },
          })}\n\n`
        );
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "greeting");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "clarification") {
        startSSE(reply);
        const content = await generateClarificationResponse(effectiveMessage);

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "start",
            id: msgId,
            session_id: sessionId,
            createdAt: timestamp,
            metadata: { intent: "clarification" },
          })}\n\n`
        );
        reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
        reply.raw.write(
          `data: ${JSON.stringify({
            type: "done",
            metadata: { type: "clarification" },
          })}\n\n`
        );
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "clarification");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "technical") {
        startSSE(reply);

        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        console.log("[AGENT /run] pipeline call", { sessionId, requestId });

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "start",
            id: msgId,
            session_id: sessionId,
            request_id: requestId,
            createdAt: timestamp,
            metadata: { intent: intent.type },
          })}\n\n`
        );

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "progress",
            stage: "pipeline_start",
            message:
              lang === "en"
                ? "🚀 Starting full development pipeline..."
                : "🚀 شروع پایپلاین کامل توسعه...",
          })}\n\n`
        );

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "progress",
            stage: "planning",
            message:
              lang === "en"
                ? "📋 Phase 1/5: Planning architecture..."
                : "📋 فاز 1/5: طراحی معماری...",
          })}\n\n`
        );

        try {
          await runPipeline({
            message: plannerContextMessage,
            sessionId,
            requestId,
          });
        } catch (pipelineError) {
          reply.raw.write(
            `data: ${JSON.stringify({
              type: "error",
              error: "Pipeline execution failed",
              details: pipelineError.message,
              request_id: requestId,
            })}\n\n`
          );
          reply.raw.end();

          saveMessage(
            sessionId,
            "assistant",
            `Pipeline failed: ${pipelineError.message}`,
            "technical"
          );
          touchSession(sessionId);
          return reply;
        }

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "progress",
            stage: "completed",
            message:
              lang === "en"
                ? "✅ All phases completed! Preparing summary..."
                : "✅ همه فازها تکمیل شد! آماده‌سازی خلاصه...",
          })}\n\n`
        );

        const plannerPlanPath = path.resolve(PLANS_DIR, "planner_plan.json");
        let plan = {};
        const latestPlan = "planner_plan.json";

        try {
          plan = JSON.parse(await fs.readFile(plannerPlanPath, "utf-8"));
        } catch (err) {
          console.warn("⚠️  Could not read planner_plan.json:", err.message);
        }

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "plan_metadata",
            plan_file: latestPlan,
            plan_path: plannerPlanPath,
            phases_count: plan.phases?.length || 0,
            files_count: plan.files?.length || 0,
            tech_stack: plan.tech_stack || {},
          })}\n\n`
        );

        const summary = await streamPlanSummary(plan, plannerContextMessage, reply);

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "done",
            summary,
            metadata: {
              type: "pipeline",
              intent: intent.type,
              plan_file: latestPlan,
              plan_path: plannerPlanPath,
              plan_summary: {
                name: plan.name,
                project_type: plan.project_type,
                goal: plan.goal,
                tech_stack: plan.tech_stack,
                phases_count: plan.phases?.length || 0,
                files_count: plan.files?.length || 0,
              },
              plan,
              full_plan_url: `/api/agent/plan/${latestPlan}`,
              request_id: requestId,
            },
          })}\n\n`
        );

        reply.raw.end();
        saveMessage(sessionId, "assistant", summary, "technical");
        touchSession(sessionId);
        return reply;
      }

      startSSE(reply);
      const content = await generateCasualResponse(effectiveMessage);

      reply.raw.write(
        `data: ${JSON.stringify({
          type: "start",
          id: msgId,
          session_id: sessionId,
          createdAt: timestamp,
          metadata: { intent: "casual" },
        })}\n\n`
      );
      reply.raw.write(`data: ${JSON.stringify({ type: "content", content })}\n\n`);
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "done",
          metadata: { type: "casual" },
        })}\n\n`
      );
      reply.raw.end();

      saveMessage(sessionId, "assistant", content, "casual");
      touchSession(sessionId);
      return reply;
    } catch (error) {
      console.error("❌ Error in agent route:", error);
      if (reply.raw.headersSent) {
        reply.raw.write(
          `data: ${JSON.stringify({
            type: "error",
            error: "Internal server error",
            details: error.message,
          })}\n\n`
        );
        reply.raw.end();
      } else {
        return reply.code(500).send({
          ok: false,
          error: "Internal server error",
          details: error.message,
        });
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
      return reply.code(500).send({
        ok: false,
        error: "Failed to read plan",
        details: error.message,
      });
    }
  });

  fastify.get("/sessions", async (request, reply) => {
    setCors(reply);
    try {
      const sessions = listSessions();
      return reply.send({ ok: true, sessions });
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: "Failed to list sessions",
        details: error.message,
      });
    }
  });

  fastify.get("/sessions/:sessionId", async (request, reply) => {
    setCors(reply);
    try {
      const messages = getSessionMessages(request.params.sessionId);
      return reply.send({
        ok: true,
        session_id: request.params.sessionId,
        messages,
      });
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: "Failed to get session",
        details: error.message,
      });
    }
  });

  fastify.delete("/sessions/:sessionId", async (request, reply) => {
    setCors(reply);
    try {
      deleteSession(request.params.sessionId);
      return reply.send({ ok: true, deleted: request.params.sessionId });
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: "Failed to delete session",
        details: error.message,
      });
    }
  });

  fastify.post("/transcribe", async (request, reply) => {
    console.log("🎙️ /transcribe hit");
    setCors(reply);

    try {
      if (typeof request.file !== "function") {
        return reply.code(400).send({
          ok: false,
          error:
            "Multipart upload is not enabled. Install and register @fastify/multipart.",
        });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({
          ok: false,
          error: "No audio file provided. Upload audio file in 'audio' field.",
        });
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
        message:
          "Audio transcribed successfully. Use the 'transcribed_text' as the message for /run endpoint.",
      });
    } catch (error) {
      console.error("❌ Transcription endpoint error:", error);

      const msg = error.message || "";
      const isRateLimit =
        msg.includes("rate limit") ||
        msg.includes("429") ||
        error.code === "api_limit";

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
        return reply.code(400).send({
          ok: false,
          error: "session_id and request_id are required",
        });
      }

      console.log(`🕙 Undo requested for session=${sessionId}, request=${requestId}`);

      const result = undoRequestChanges({ sessionId, requestId });

      return reply.send({
        ok: true,
        session_id: sessionId,
        request_id: requestId,
        result,
      });
    } catch (err) {
      console.error("❌ Error in /undo route:", err);

      return reply.code(500).send({
        ok: false,
        error: "Failed to undo changes",
        details: err.message,
      });
    }
  });
}