import "./config/env.mjs"; // MUST stay first — loads .env before other modules read it
import Fastify from "fastify";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import settingsRoute from "./routes/settings.mjs";
import plannerAgentRoute from "./routes/plannerAgent.mjs";
import authRoute, { provisionCliSession } from "./routes/auth.mjs";
import { CLI_WORKSPACE } from "./config/workspace.mjs";
import workspaceRoute from "./routes/workspace.mjs";
import feedbackRoute from "./routes/feedback.mjs";
import { allowedOrigin, PINNED_ORIGIN, DEFAULT_ORIGIN } from "./utils/cors.util.mjs";


const fastify = Fastify({
  logger: true,
});

// Fastify's default JSON parser 400s on an empty body (FST_ERR_CTP_EMPTY_JSON_BODY).
// The UI legitimately sends body-less JSON POSTs (e.g. the plan-approval
// /confirm/:requestId click) — treat an empty body as {} instead of erroring.
fastify.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  const text = String(body || "").trim();
  if (!text) return done(null, {});
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

let multipartAvailable = false;
let multipartPlugin = null;

try {
  const mod = await import("@fastify/multipart");
  multipartPlugin = mod.default || mod;
  multipartAvailable = true;
} catch (err) {
  fastify.log.warn(
    "@fastify/multipart is not installed. Upload endpoint will be disabled until you run: npm i @fastify/multipart"
  );
}

async function ensureUploadDir() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  } catch (err) {
    fastify.log.error(err);
  }
}

await ensureUploadDir();

if (multipartAvailable && multipartPlugin) {
  await fastify.register(multipartPlugin, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 10,
      fields: 50,
    },
  });
}

// CORS — see utils/cors.util.mjs for the rule and why it is not "*".
const ALLOWED_ORIGIN = PINNED_ORIGIN || DEFAULT_ORIGIN;

fastify.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-ID", crypto.randomUUID());
  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Origin", allowedOrigin(request.headers.origin));
  reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  reply.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  if (request.method === "OPTIONS") {
    return reply.code(204).send();
  }
});

fastify.post("/api/agent/upload", async (request, reply) => {
  if (typeof request.file !== "function") {
    return reply.code(400).send({
      ok: false,
      error:
        "Multipart upload is disabled because @fastify/multipart is not installed. Run: npm i @fastify/multipart",
    });
  }

  try {
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({
        ok: false,
        error: "No file uploaded",
      });
    }

    const timestamp = Date.now();
    const safeFilename = `${timestamp}-${file.filename}`
      .replace(/\s+/g, "-")
      .replace(/[^\w.-]/g, "");

    const filepath = path.join(UPLOAD_DIR, safeFilename);

    await pipeline(file.file, createWriteStream(filepath));

    const stat = await fs.stat(filepath);
    const relativePath = path.posix.join("uploads", safeFilename);

    return {
      ok: true,
      filename: safeFilename,
      originalName: file.filename,
      mimetype: file.mimetype,
      size: stat.size,
      path: relativePath,
      absolute_path: filepath,
      url: `/uploads/${safeFilename}`,
    };
  } catch (err) {
    fastify.log.error(err);

    return reply.code(500).send({
      ok: false,
      error: err.message,
    });
  }
});

fastify.get("/uploads/:filename", async (request, reply) => {
  const { filename } = request.params;
  // Serve only plain basenames — no separators, no traversal, no hidden files.
  if (!/^[\w][\w.-]*$/.test(filename) || filename.includes("..")) {
    return reply.code(400).send({ ok: false, error: "Invalid filename" });
  }
  const filePath = path.join(UPLOAD_DIR, filename);

  try {
    await fs.access(filePath);
    const data = await fs.readFile(filePath);
    return reply.type("application/octet-stream").send(data);
  } catch {
    return reply.code(404).send({
      ok: false,
      error: "File not found",
    });
  }
});

await fastify.register(plannerAgentRoute, {
  prefix: "/api/agent",
});

await fastify.register(settingsRoute, {
  prefix: "/api/settings",
});


await fastify.register(authRoute, {
  prefix: "/api/auth",
});

await fastify.register(workspaceRoute, {
  prefix: "/api/workspace",
});

await fastify.register(feedbackRoute, {
  prefix: "/api/feedback",
});

// Global error handler: ensures every unhandled error returns consistent JSON
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  const statusCode = error.statusCode || error.status || 500;
  return reply.code(statusCode).send({
    ok: false,
    error: error.message || "Internal Server Error",
    statusCode: statusCode,
  });
});

fastify.get("/health", async () => {
  return {
    status: "ok",
    uploads: UPLOAD_DIR,
    multipart: multipartAvailable,
  };
});

// Graceful shutdown: every live session gets its SessionEnd hook with an
// explicit reason, so cleanup runs even though the process is going away.
// Bounded inside endAllSessions — a slow hook must not wedge shutdown.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) return; // a second Ctrl-C should not re-enter
    shuttingDown = true;
    console.log(`\n[Server] ${signal} — closing sessions...`);
    try {
      const { shutdownBackgroundSubagents } = await import("./services/backgroundSubagents.mjs");
      const { aborted } = await shutdownBackgroundSubagents();
      if (aborted) console.log(`[Server] aborted ${aborted} background subagent(s)`);

      const { endAllSessions } = await import("./services/sessionHooks.mjs");
      const ended = await endAllSessions("shutdown");
      if (ended.length) console.log(`[Server] SessionEnd fired for ${ended.length} session(s)`);

      // Worktrees last: background cleanup may still have been removing them.
      const { removeAllWorktrees } = await import("./services/worktreeManager.mjs");
      const wt = await removeAllWorktrees();
      if (wt.length) console.log(`[Server] removed ${wt.filter((w) => w.removed).length}/${wt.length} worktree(s)`);
    } catch (err) {
      console.warn("[Server] SessionEnd during shutdown failed:", err.message);
    }
    try { await fastify.close(); } catch { /* already closing */ }
    process.exit(0);
  });
}

// Port and host are configurable so `kodo server start --port N` can place this
// somewhere other than 9000 (which is routinely already taken) and so the E2E
// tests can bind an ephemeral port.
//
// The default host is now LOOPBACK, not 0.0.0.0. This process exposes an agent
// that edits files and runs shell commands; binding it to every interface by
// default published that to the whole local network — including coffee-shop
// Wi-Fi — with no authentication beyond a bearer token the UI hands out. Anyone
// who genuinely needs a wider bind (a container with its own network boundary)
// can still ask for it explicitly via KODO_HOST.
const PORT = Number(process.env.PORT || process.env.KODO_PORT || 9000);
const HOST = process.env.KODO_HOST || "127.0.0.1";

async function start() {
  try {
    // BEFORE listen, so that "the API is healthy" also means "the CLI can read
    // the session token". The CLI polls /health and then builds the browser URL
    // from the handshake file; provisioning after listen would race that.
    if (CLI_WORKSPACE) provisionCliSession(CLI_WORKSPACE);

    await fastify.listen({ port: PORT, host: HOST });

    if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
      console.warn(
        `⚠️  Kodo is bound to ${HOST} — the agent is reachable from outside this machine. ` +
        "Anything that can reach this port can edit your files and run commands as you.",
      );
    }
    console.log(`✅ Server running on http://${HOST}:${PORT}`);
    console.log("📁 Uploads directory:", UPLOAD_DIR);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();