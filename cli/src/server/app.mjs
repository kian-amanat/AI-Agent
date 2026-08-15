/**
 * src/server/app.mjs — the local Kodo runtime server.
 *
 * Browser → HTTP/SSE → this server → Kodo Core → agent.
 *
 * This file owns NO agent logic. It manages sessions, streams events, and hands
 * every actual instruction to core.runAgent — the same entry point `kodo run`
 * uses. If agent behaviour ever needs changing, it does not change here.
 *
 * Built on node:http rather than Fastify: the CLI ships with zero runtime
 * dependencies, and a locally-bound control plane with six routes does not
 * justify pulling a framework (and its install-time build step) onto every
 * machine that installs Kodo. backend1's Fastify server is a separate,
 * still-supported surface — see `kodo server`.
 *
 * SECURITY POSTURE. This server can edit files and run commands as you.
 *   - Binds 127.0.0.1 by default; a non-loopback bind demands --yes-i-know.
 *   - Every mutating request must carry the runtime token, which is generated
 *     per start, stored 0600 in ~/.kodo/runtime, and never logged. That closes
 *     the DNS-rebinding hole a bare localhost server would otherwise have: a
 *     malicious page can make your browser POST to 127.0.0.1, but it cannot
 *     read a file to learn the token.
 *   - Origin is checked on browser requests for the same reason.
 */

import crypto from "crypto";
import http from "http";
import { EVENT, toPublicEvent } from "../events.mjs";
import { identityOf } from "../runtime/identity.mjs";
import { renderUi } from "./ui.mjs";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/**
 * @param {{core, token, version, workspace, modelRoute, permissionMode, log}} deps
 */
export function createApp(deps) {
  const sessions = new Map();   // id → {id, title, status, createdAt, events[], subscribers:Set}

  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { ...JSON_HEADERS, ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  /**
   * A request is authorised if it presents the runtime token. Bare GETs of the
   * UI shell and /health are exempt: /health is what the lifecycle manager and
   * `kodo doctor` poll before they have any token in hand, and it deliberately
   * discloses nothing but liveness, version and the identity token echo used to
   * prove this process is the one the state file describes.
   */
  const authorised = (req) => {
    const header = req.headers["authorization"] || "";
    if (header.startsWith("Bearer ") && header.slice(7) === deps.token) return true;
    const url = new URL(req.url, "http://localhost");
    return url.searchParams.get("token") === deps.token;
  };

  /**
   * Reject cross-origin browser traffic. Same-origin fetches from the served UI
   * send Origin equal to our own address; a hostile page sends its own.
   */
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;                       // curl, the CLI itself, non-browser clients
    try {
      const { hostname } = new URL(origin);
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    } catch {
      return false;
    }
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error("Request body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });

  const publicSession = (s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    workspace: s.workspace,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turns: s.turns,
    eventCount: s.events.length,
  });

  const broadcast = (session, event) => {
    session.events.push(event);
    if (session.events.length > 2000) session.events.splice(0, session.events.length - 2000);
    for (const write of session.subscribers) {
      try { write(event); } catch { /* a dead subscriber is dropped on its own close */ }
    }
  };

  async function startRun(session, message) {
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    session.controller = new AbortController();

    broadcast(session, { type: EVENT.SESSION_STARTED, sessionId: session.id, message });

    try {
      const result = await deps.core.runAgent({
        userMessage: message,
        sessionId: session.id,
        requestId: `srv_${Date.now().toString(36)}`,
        userId: "cli",
        workspacePath: session.workspace,
        modelRoute: deps.modelRoute,
        visionRoute: { ok: false },
        permissionMode: deps.permissionMode,
        abortSignal: session.controller.signal,
        emit: (e) => {
          const pub = toPublicEvent(e);
          if (pub) broadcast(session, pub);
        },
      });
      session.turns += 1;
      session.status = session.controller.signal.aborted ? "cancelled" : "completed";
      broadcast(session, {
        type: EVENT.SESSION_COMPLETED,
        sessionId: session.id,
        success: !session.controller.signal.aborted,
        editedFiles: result?.editedFiles || [],
        summary: result?.finalAnswer || "",
      });
    } catch (err) {
      session.status = "error";
      broadcast(session, { type: EVENT.AGENT_ERROR, error: err.message });
      broadcast(session, { type: EVENT.SESSION_COMPLETED, sessionId: session.id, success: false });
    } finally {
      session.controller = null;
      session.updatedAt = new Date().toISOString();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = url.pathname;

    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    if (!originAllowed(req)) return send(res, 403, { ok: false, error: "cross_origin_blocked" });

    try {
      // ── Liveness: no token required, discloses nothing sensitive ────────────
      if (route === "/health") {
        return send(res, 200, {
          status: "ok",
          version: deps.version,
          // A HASH of the runtime token, never the token. Whoever already holds
          // the token (the CLI, which wrote it 0600 into ~/.kodo/runtime) can
          // recompute this and confirm "the process on this port is the one my
          // state file describes". Anyone else learns nothing usable — returning
          // the token itself would have handed a bearer credential to every
          // process on the machine, including other users' on a shared host.
          identity: identityOf(deps.token),
          workspace: deps.workspace,
          uptimeMs: Math.round(process.uptime() * 1000),
        });
      }

      // ── The UI shell. The page fetches nothing until it is given a token. ───
      if (route === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(renderUi({ version: deps.version, workspace: deps.workspace }));
      }

      if (!route.startsWith("/api/")) return send(res, 404, { ok: false, error: "not_found" });

      if (!authorised(req)) {
        return send(res, 401, { ok: false, error: "unauthorized", message: "Missing or invalid runtime token." });
      }

      if (route === "/api/status" && req.method === "GET") {
        return send(res, 200, {
          ok: true,
          version: deps.version,
          workspace: deps.workspace,
          permissionMode: deps.permissionMode,
          model: deps.modelRoute?.model || null,   // never the key
          sessions: sessions.size,
          running: [...sessions.values()].filter((s) => s.status === "running").length,
        });
      }

      if (route === "/api/sessions" && req.method === "GET") {
        return send(res, 200, { ok: true, sessions: [...sessions.values()].map(publicSession) });
      }

      if (route === "/api/sessions" && req.method === "POST") {
        const body = await readBody(req);
        const id = `web_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
        const session = {
          id,
          title: String(body.title || "").slice(0, 80),
          status: "idle",
          workspace: deps.workspace,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          turns: 0,
          events: [],
          subscribers: new Set(),
          controller: null,
        };
        sessions.set(id, session);
        return send(res, 201, { ok: true, session: publicSession(session) });
      }

      const match = route.match(/^\/api\/sessions\/([^/]+)(?:\/(\w+))?$/);
      if (match) {
        const session = sessions.get(match[1]);
        if (!session) return send(res, 404, { ok: false, error: "no_such_session" });
        const action = match[2];

        if (!action && req.method === "GET") {
          return send(res, 200, { ok: true, session: publicSession(session), events: session.events });
        }

        if (action === "messages" && req.method === "POST") {
          const body = await readBody(req);
          const message = String(body.message || "").trim();
          if (!message) return send(res, 400, { ok: false, error: "message_required" });
          if (session.status === "running") {
            return send(res, 409, { ok: false, error: "session_busy" });
          }
          if (!session.title) session.title = message.slice(0, 80);
          // Fire and forget: the caller watches /events, exactly as the web UI
          // does. A dropped HTTP connection must not stop an agent mid-edit.
          void startRun(session, message);
          return send(res, 202, { ok: true, sessionId: session.id });
        }

        if ((action === "cancel" || action === "stop") && req.method === "POST") {
          const wasRunning = Boolean(session.controller);
          session.controller?.abort();
          return send(res, 200, { ok: true, cancelled: wasRunning });
        }

        if (action === "events" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const write = (event) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
          };
          // Replay so a reconnecting client catches up rather than losing the
          // first half of a run it was not connected for.
          const from = Number(url.searchParams.get("from") || 0);
          for (const e of session.events.slice(from)) write(e);
          session.subscribers.add(write);
          req.on("close", () => session.subscribers.delete(write));
          return undefined;
        }
      }

      return send(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      deps.log?.(`request failed: ${err.message}`);
      return send(res, 500, { ok: false, error: "internal_error", message: err.message });
    }
  });

  /**
   * Graceful shutdown: stop accepting, abort every live agent run (which is
   * what tears down its child processes and MCP servers), then close.
   * Without the abort, Ctrl+C would leave orphaned bash and MCP processes
   * behind — the run holds them, not the HTTP server.
   */
  server.shutdown = async () => {
    for (const session of sessions.values()) {
      session.controller?.abort();
      for (const write of session.subscribers) {
        try { write({ type: EVENT.AGENT_ERROR, error: "server_shutting_down" }); } catch { /* closing anyway */ }
      }
      session.subscribers.clear();
    }
    await new Promise((resolve) => server.close(resolve));
  };

  server.sessions = sessions;
  return server;
}
