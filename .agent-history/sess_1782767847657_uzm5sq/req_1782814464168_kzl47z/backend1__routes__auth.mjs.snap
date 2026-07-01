// backend1/routes/auth.mjs
// Register in server.mjs with:
//   import authRoute from "./routes/auth.mjs";
//   await fastify.register(authRoute, { prefix: "/api/auth" });

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import db from "../db.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "kodo-local-dev-secret";
const TOKEN_FILE = path.join(os.homedir(), ".kodo", "token.json");

// ─── Helpers ─────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function signToken(userId, sessionId) {
  return jwt.sign({ userId, sessionId }, JWT_SECRET, { expiresIn: "30d" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function writeTokenFile(token, sessionId) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, sessionId }), "utf-8");
}

function clearTokenFile() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

// ─── Auth decorator (reusable inside this plugin) ─────────────────

function getAuthUser(request) {
  const auth = request.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return null;

  const payload = verifyToken(auth.slice(7));
  if (!payload) return null;

  const session = db
    .prepare("SELECT * FROM auth_sessions WHERE id = ?")
    .get(payload.sessionId);
  if (!session) return null;

  // touch last_active
  db.prepare("UPDATE auth_sessions SET last_active = ? WHERE id = ?").run(
    nowIso(),
    payload.sessionId
  );

  const user = db
    .prepare("SELECT id, email, name, plan, created_at FROM users WHERE id = ?")
    .get(payload.userId);

  return { user, session };
}

// ─── Plugin ──────────────────────────────────────────────────────

export default async function authRoute(fastify) {
  // POST /api/auth/signup
  fastify.post("/signup", async (request, reply) => {
    const { email, password, name } = request.body ?? {};

    if (!email || !password || !name) {
      return reply
        .code(400)
        .send({ ok: false, error: "email, password and name are required" });
    }
    if (password.length < 6) {
      return reply
        .code(400)
        .send({ ok: false, error: "Password must be at least 6 characters" });
    }

    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);
    if (existing) {
      return reply
        .code(409)
        .send({ ok: false, error: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = db
      .prepare("INSERT INTO users (email, password, name) VALUES (?, ?, ?)")
      .run(email, hashed, name);

    const userId = result.lastInsertRowid;
    const sessionId = generateId("sess");
    const token = signToken(userId, sessionId);

    db.prepare(
      "INSERT INTO auth_sessions (id, user_id, token, created_at, last_active) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, userId, token, nowIso(), nowIso());

    writeTokenFile(token, sessionId);

    const user = db
      .prepare(
        "SELECT id, email, name, plan, created_at FROM users WHERE id = ?"
      )
      .get(userId);

    return { ok: true, token, sessionId, user };
  });

  // POST /api/auth/login
  fastify.post("/login", async (request, reply) => {
    const { email, password } = request.body ?? {};

    if (!email || !password) {
      return reply
        .code(400)
        .send({ ok: false, error: "email and password are required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return reply
        .code(401)
        .send({ ok: false, error: "Invalid email or password" });
    }

    const sessionId = generateId("sess");
    const token = signToken(user.id, sessionId);

    db.prepare(
      "INSERT INTO auth_sessions (id, user_id, token, created_at, last_active) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionId, user.id, token, nowIso(), nowIso());

    writeTokenFile(token, sessionId);

    return {
      ok: true,
      token,
      sessionId,
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
    };
  });

  // POST /api/auth/logout
  fastify.post("/logout", async (request, reply) => {
    const auth = getAuthUser(request);
    if (auth) {
      db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(
        auth.session.id
      );
    }
    clearTokenFile();
    return { ok: true };
  });

  // GET /api/auth/me
  fastify.get("/me", async (request, reply) => {
    const auth = getAuthUser(request);
    if (!auth) return reply.code(401).send({ ok: false, error: "Unauthorized" });

    return { ok: true, user: auth.user, session: auth.session };
  });

  // POST /api/auth/workspace  — extension calls this after login to bind its workspace path
  fastify.post("/workspace", async (request, reply) => {
    const auth = getAuthUser(request);
    if (!auth) return reply.code(401).send({ ok: false, error: "Unauthorized" });

    const { workspacePath, workspaceName } = request.body ?? {};
    if (!workspacePath) {
      return reply
        .code(400)
        .send({ ok: false, error: "workspacePath is required" });
    }

    db.prepare(
      "UPDATE auth_sessions SET workspace_path = ?, workspace_name = ? WHERE id = ?"
    ).run(
      workspacePath,
      workspaceName || path.basename(workspacePath),
      auth.session.id
    );

    return { ok: true, workspacePath, workspaceName };
  });

  // POST /api/auth/handshake
  // Called by web UI after login so the extension can detect the token via file polling.
  fastify.post("/handshake", async (request, reply) => {
    const { token, sessionId } = request.body ?? {};
    if (!token || !sessionId) {
      return reply
        .code(400)
        .send({ ok: false, error: "token and sessionId required" });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return reply.code(401).send({ ok: false, error: "Invalid token" });
    }

    writeTokenFile(token, sessionId);
    return { ok: true };
  });

  // DELETE /api/auth/handshake — clear on logout from browser
  fastify.delete("/handshake", async (request, reply) => {
    clearTokenFile();
    return { ok: true };
  });
}

// ─── Export verifyToken so server.mjs can use it for other routes ─
export { verifyToken, getAuthUser };
