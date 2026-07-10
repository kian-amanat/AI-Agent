import Fastify from "fastify";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import settingsRoute from "./routes/settings.mjs";
import plannerAgentRoute from "./routes/plannerAgent.mjs";
import authRoute from "./routes/auth.mjs";


const fastify = Fastify({
  logger: true,
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

fastify.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-ID", crypto.randomUUID());
  reply.header("Access-Control-Allow-Origin", "*");
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

async function start() {
  try {
    await fastify.listen({
      port: 9000,
      host: "0.0.0.0",
    });

    console.log("✅ Server running on http://localhost:9000");
    console.log("📁 Uploads directory:", UPLOAD_DIR);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();