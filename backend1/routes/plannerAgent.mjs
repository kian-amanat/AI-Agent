import { promises as fs } from "fs";
import path from "path";

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
import { PLANS_DIR } from "../config/openai.mjs";
import { uniq } from "../utils/text.util.mjs";

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
    } catch {}

    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
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

    const effectiveMessage =
      message || (attachments.length ? "Please analyze the uploaded attachment(s)." : "");

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
      const intent = classifyIntent(effectiveMessage, attachments);
      console.log(`📊 Intent: ${intent.type}`);

      const msgId = `msg_${Date.now()}`;
      const timestamp = new Date().toISOString();
      const lang = detectLanguage(effectiveMessage);

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
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "crisis" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "crisis");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "inspection") {
        startSSE(reply);
        const content = await generateInspectionResponse(effectiveMessage, attachments);

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
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "inspection" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "inspection");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "code_request") {
        startSSE(reply);
        const content = await generateCodeResponse(effectiveMessage, attachments);

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
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "code_request" } })}\n\n`);
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
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "greeting" } })}\n\n`);
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
        reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "clarification" } })}\n\n`);
        reply.raw.end();

        saveMessage(sessionId, "assistant", content, "clarification");
        touchSession(sessionId);
        return reply;
      }

      if (intent.type === "technical") {
        startSSE(reply);

        reply.raw.write(
          `data: ${JSON.stringify({
            type: "start",
            id: msgId,
            session_id: sessionId,
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
          await runPipeline(effectiveMessage);
        } catch (pipelineError) {
          reply.raw.write(
            `data: ${JSON.stringify({
              type: "error",
              error: "Pipeline execution failed",
              details: pipelineError.message,
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

        const summary = await streamPlanSummary(plan, effectiveMessage, reply);

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
      reply.raw.write(`data: ${JSON.stringify({ type: "done", metadata: { type: "casual" } })}\n\n`);
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
}