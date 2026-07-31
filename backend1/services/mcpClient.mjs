// services/mcpClient.mjs
// A minimal MCP (Model Context Protocol) client: spawns a server declared in
// a workspace's .kodo/settings.json `mcpServers`, speaks MCP's stdio
// transport (newline-delimited JSON-RPC 2.0 — no Content-Length framing,
// unlike LSP), and exposes listTools()/callTool(). This is the actual
// Claude-Code mechanism for optional capabilities (browser automation, DB
// access, etc.): the core agent doesn't hardcode them, a project attaches
// whatever MCP server it needs via config, and its tools appear alongside
// the built-ins. Confirmed against a real @playwright/mcp instance during
// development — request/response shapes below match its actual output.
//
// Lifecycle: one client per configured server per agent run (not shared
// across runs, not long-lived like the ad-hoc background-bash registry) —
// spawned lazily on first use, closed at the end of the run via close().

import { spawn } from "child_process";
import readline from "readline";
import { sanitizedChildEnv } from "../utils/process.util.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

export class McpClient {
  constructor({ command, args = [], cwd, env = {}, onSampling = null, onElicitation = null }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.extraEnv = env;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.ready = null;
    // Server→client completion callback. Only advertised to the server when
    // present, so a server never asks for sampling we can't perform.
    this.onSampling = onSampling;
    // Server→client request for USER input (elicitation/create).
    this.onElicitation = onElicitation;
  }

  // Spawn + MCP handshake (initialize → notifications/initialized). Safe to
  // call multiple times — subsequent calls reuse the same in-flight/started
  // connection instead of spawning a second process.
  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }

  async _start() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...sanitizedChildEnv(), ...this.extraEnv },
      detached: process.platform !== "win32",
    });
    this.child = child;
    child.unref?.();

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this._handleLine(line));

    // Kept only for surfacing IN an exit/error rejection — an MCP server
    // that fails to start (missing browser binary, bad args, wrong cwd) logs
    // the real reason here, and a bare "exited code 1" with nothing else is
    // nearly undebuggable.
    let stderrTail = "";
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    // Guard on identity: after close() (or a restart) this client may already
    // own a NEWER child, and the old process exiting must not reject requests
    // that belong to the new one — that made a reused client permanently dead.
    child.on("exit", (code) => {
      if (this.child !== child) return;
      const detail = stderrTail.trim() ? `\n${stderrTail.trim().slice(-500)}` : "";
      const err = new Error(`MCP server "${this.command}" exited (code ${code}) before responding.${detail}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    const initResult = await this._request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        ...(this.onSampling ? { sampling: {} } : {}),
        ...(this.onElicitation ? { elicitation: {} } : {}),
      },
      clientInfo: { name: "kodo", version: "1.0.0" },
    });
    this._notify("notifications/initialized", {});
    return initResult;
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON noise on stdout

    // Inbound REQUEST from the server (it has an id AND a method) — MCP is
    // bidirectional, and sampling/createMessage is the server asking US to run
    // a completion on its behalf. Anything we don't implement must still get a
    // JSON-RPC error reply, or the server hangs waiting forever.
    if (msg.id !== undefined && typeof msg.method === "string") {
      void this._handleServerRequest(msg);
      return;
    }

    if (msg.id === undefined || !this.pending.has(msg.id)) return; // notification, not a reply we're waiting on
    const { resolve, reject } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "MCP error"));
    else resolve(msg.result);
  }

  async _handleServerRequest(msg) {
    const reply = (body) => {
      try { this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }) + "\n"); }
      catch { /* server already gone */ }
    };

    if (msg.method === "sampling/createMessage") {
      if (!this.onSampling) {
        reply({ error: { code: -32601, message: "Sampling is not enabled for this client." } });
        return;
      }
      try {
        reply({ result: await this.onSampling(msg.params || {}) });
      } catch (err) {
        reply({ error: { code: -32603, message: String(err?.message || err).slice(0, 300) } });
      }
      return;
    }

    // elicitation/create — the server is asking the USER for input. Distinct
    // from sampling (which asks the MODEL); never conflate the two.
    if (msg.method === "elicitation/create") {
      if (!this.onElicitation) {
        reply({ error: { code: -32601, message: "Elicitation is not enabled for this client." } });
        return;
      }
      try {
        reply({ result: await this.onElicitation(msg.params || {}) });
      } catch (err) {
        reply({ error: { code: -32603, message: String(err?.message || err).slice(0, 300) } });
      }
      return;
    }

    reply({ error: { code: -32601, message: `Method "${msg.method}" is not supported by this client.` } });
  }

  _notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async listTools() {
    await this.start();
    const result = await this._request("tools/list", {});
    return result?.tools || [];
  }

  // Returns the tool's content blocks (usually [{type:"text", text}]).
  // Concatenates text blocks into one string for the common case; callers
  // that need raw blocks (e.g. to notice an image block) can pass raw:true.
  async callTool(name, args = {}, { raw = false } = {}) {
    await this.start();
    const result = await this._request("tools/call", { name, arguments: args });
    const content = result?.content || [];
    if (raw) return { content, isError: !!result?.isError };
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { text, isError: !!result?.isError };
  }

  // ── Resources ──────────────────────────────────────────────────────────
  // Read-only context a server exposes by URI (files, records, docs).
  async listResources() {
    await this.start();
    const result = await this._request("resources/list", {});
    return result?.resources || [];
  }

  async readResource(uri) {
    await this.start();
    const result = await this._request("resources/read", { uri });
    return flattenResourceContents(result?.contents);
  }

  // ── Prompts ────────────────────────────────────────────────────────────
  // Reusable prompt templates the server ships.
  async listPrompts() {
    await this.start();
    const result = await this._request("prompts/list", {});
    return result?.prompts || [];
  }

  async getPrompt(name, args = {}) {
    await this.start();
    const result = await this._request("prompts/get", { name, arguments: args });
    return { description: result?.description || "", messages: result?.messages || [] };
  }

  close() {
    if (!this.child) return;
    const pid = this.child.pid;
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch {
      try { this.child.kill("SIGTERM"); } catch {}
    }
    for (const { reject } of this.pending.values()) reject(new Error("MCP client closed"));
    this.pending.clear();
    this.child = null;
    this.ready = null;
  }
}

// ── Streamable HTTP transport ────────────────────────────────────────────────
// Claude Code's remote-server shape ({ type:"http", url, headers }). Same
// public surface as McpClient (listTools/callTool/close) so callers stay
// transport-agnostic. Per the MCP spec a POST may answer with either
// application/json or an text/event-stream frame carrying the JSON-RPC reply,
// and a server that issues an Mcp-Session-Id on initialize expects it echoed
// back on every later request.
export class HttpMcpClient {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.nextId = 1;
    this.sessionId = null;
    this.ready = null;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }

  async _start() {
    const result = await this._request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "kodo", version: "1.0.0" },
    });
    await this._request("notifications/initialized", {}, { notify: true });
    return result;
  }

  async _request(method, params, { notify = false } = {}) {
    const body = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: this.nextId++, method, params };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        err?.name === "AbortError"
          ? `MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `MCP request "${method}" failed: ${err?.message || err}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const issued = res.headers.get("mcp-session-id");
    if (issued) this.sessionId = issued;
    if (notify) return null;
    if (!res.ok) throw new Error(`MCP server returned HTTP ${res.status} for "${method}"`);

    const raw = await res.text();
    const payload = (res.headers.get("content-type") || "").includes("text/event-stream")
      ? parseSsePayload(raw)
      : safeParseJSON(raw);

    if (!payload) throw new Error(`MCP server sent an unreadable reply to "${method}"`);
    if (payload.error) throw new Error(payload.error.message || "MCP error");
    return payload.result;
  }

  async listTools() {
    await this.start();
    const result = await this._request("tools/list", {});
    return result?.tools || [];
  }

  async callTool(name, args = {}, { raw = false } = {}) {
    await this.start();
    const result = await this._request("tools/call", { name, arguments: args });
    const content = result?.content || [];
    if (raw) return { content, isError: !!result?.isError };
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { text, isError: !!result?.isError };
  }

  async listResources() {
    await this.start();
    const result = await this._request("resources/list", {});
    return result?.resources || [];
  }

  async readResource(uri) {
    await this.start();
    const result = await this._request("resources/read", { uri });
    return flattenResourceContents(result?.contents);
  }

  async listPrompts() {
    await this.start();
    const result = await this._request("prompts/list", {});
    return result?.prompts || [];
  }

  async getPrompt(name, args = {}) {
    await this.start();
    const result = await this._request("prompts/get", { name, arguments: args });
    return { description: result?.description || "", messages: result?.messages || [] };
  }

  close() {
    this.ready = null;
    this.sessionId = null;
  }
}

// resources/read returns blocks that are either text or base64 blobs. Text is
// what the model can actually use; a binary blob is reported by type/size
// rather than dumped as base64 into the context window.
export function flattenResourceContents(contents) {
  const blocks = Array.isArray(contents) ? contents : [];
  return blocks.map((c) => {
    if (typeof c?.text === "string") return c.text;
    if (typeof c?.blob === "string") {
      const bytes = Math.floor((c.blob.length * 3) / 4);
      return `[binary resource ${c.mimeType || "application/octet-stream"}, ~${bytes} bytes — not inlined]`;
    }
    return "";
  }).filter(Boolean).join("\n");
}

// ── HTTP+SSE transport ───────────────────────────────────────────────────────
// The MCP transport that holds a PERSISTENT event stream open: the client GETs
// the SSE endpoint, the server replies with an `endpoint` event naming a POST
// URL, and from then on requests go out over POST while every reply — and
// every server-INITIATED request, such as sampling/createMessage — arrives
// back down the stream. That inbound direction is what plain request/response
// HTTP cannot do, and it is why this exists alongside HttpMcpClient.
export class SseMcpClient {
  constructor({ url, headers = {}, onSampling = null, onElicitation = null }) {
    this.url = url;
    this.headers = headers;
    this.onSampling = onSampling;
    this.onElicitation = onElicitation;
    this.postUrl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.abort = null;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }

  async _start() {
    this.abort = new AbortController();
    const res = await fetch(this.url, {
      method: "GET",
      headers: { accept: "text/event-stream", ...this.headers },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed (HTTP ${res.status}) for ${this.url}`);

    // The POST endpoint arrives as the first event; requests can't be sent
    // until it does, so the handshake waits for it explicitly.
    const endpointReady = new Promise((resolve, reject) => {
      this._resolveEndpoint = resolve;
      const t = setTimeout(() => reject(new Error("SSE server never sent its endpoint event")), REQUEST_TIMEOUT_MS);
      t.unref?.();
    });

    void this._readStream(res.body);
    await endpointReady;

    const initResult = await this._request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        ...(this.onSampling ? { sampling: {} } : {}),
        ...(this.onElicitation ? { elicitation: {} } : {}),
      },
      clientInfo: { name: "kodo", version: "1.0.0" },
    });
    await this._post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return initResult;
  }

  async _readStream(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let sep;
        // SSE frames are separated by a blank line.
        while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
          this._handleFrame(frame);
        }
      }
    } catch {
      /* stream closed — close() rejects anything still pending */
    }
    for (const { reject } of this.pending.values()) reject(new Error("SSE stream closed"));
    this.pending.clear();
  }

  _handleFrame(frame) {
    let event = "message";
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    const payload = data.join("\n");
    if (!payload) return;

    if (event === "endpoint") {
      // Usually a path relative to the SSE url.
      this.postUrl = new URL(payload, this.url).toString();
      this._resolveEndpoint?.();
      return;
    }

    const msg = safeParseJSON(payload);
    if (!msg) return;

    // Server-initiated request (has both id and method) — same contract as the
    // stdio client: answer it, or reply with an error so the server isn't left
    // waiting forever.
    if (msg.id !== undefined && typeof msg.method === "string") {
      void this._handleServerRequest(msg);
      return;
    }
    if (msg.id === undefined || !this.pending.has(msg.id)) return;
    const { resolve, reject } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "MCP error"));
    else resolve(msg.result);
  }

  async _handleServerRequest(msg) {
    const reply = (body) => this._post({ jsonrpc: "2.0", id: msg.id, ...body }).catch(() => {});
    if (msg.method === "sampling/createMessage") {
      if (!this.onSampling) {
        await reply({ error: { code: -32601, message: "Sampling is not enabled for this client." } });
        return;
      }
      try {
        await reply({ result: await this.onSampling(msg.params || {}) });
      } catch (err) {
        await reply({ error: { code: -32603, message: String(err?.message || err).slice(0, 300) } });
      }
      return;
    }
    if (msg.method === "elicitation/create") {
      if (!this.onElicitation) {
        await reply({ error: { code: -32601, message: "Elicitation is not enabled for this client." } });
        return;
      }
      try {
        await reply({ result: await this.onElicitation(msg.params || {}) });
      } catch (err) {
        await reply({ error: { code: -32603, message: String(err?.message || err).slice(0, 300) } });
      }
      return;
    }
    await reply({ error: { code: -32601, message: `Method "${msg.method}" is not supported by this client.` } });
  }

  async _post(body) {
    if (!this.postUrl) throw new Error("SSE endpoint not negotiated yet");
    const res = await fetch(this.postUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(body),
    });
    // Replies come back over the SSE stream, so a POST only needs to be accepted.
    if (!res.ok) throw new Error(`SSE POST failed (HTTP ${res.status})`);
    await res.text().catch(() => "");
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._post({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async listTools() {
    await this.start();
    return (await this._request("tools/list", {}))?.tools || [];
  }

  async callTool(name, args = {}, { raw = false } = {}) {
    await this.start();
    const result = await this._request("tools/call", { name, arguments: args });
    const content = result?.content || [];
    if (raw) return { content, isError: !!result?.isError };
    return { text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), isError: !!result?.isError };
  }

  async listResources() {
    await this.start();
    return (await this._request("resources/list", {}))?.resources || [];
  }

  async readResource(uri) {
    await this.start();
    return flattenResourceContents((await this._request("resources/read", { uri }))?.contents);
  }

  async listPrompts() {
    await this.start();
    return (await this._request("prompts/list", {}))?.prompts || [];
  }

  async getPrompt(name, args = {}) {
    await this.start();
    const result = await this._request("prompts/get", { name, arguments: args });
    return { description: result?.description || "", messages: result?.messages || [] };
  }

  close() {
    try { this.abort?.abort(); } catch { /* already gone */ }
    for (const { reject } of this.pending.values()) reject(new Error("MCP client closed"));
    this.pending.clear();
    this.abort = null;
    this.ready = null;
    this.postUrl = null;
  }
}

function safeParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Pull the first JSON-RPC reply out of an SSE frame ("event: message\ndata: {…}").
function parseSsePayload(raw) {
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const parsed = safeParseJSON(line.slice(5).trim());
    if (parsed) return parsed;
  }
  return null;
}

// One client instance per (serverName, cwd) — called lazily the first time a
// run actually needs it. Dispatches on the declared transport, defaulting to
// stdio when a `command` is present (Claude Code's config convention).
export function spawnMcpServer(serverConfig, cwd, { onSampling = null, onElicitation = null } = {}) {
  const type = serverConfig.type
    || (serverConfig.command ? "stdio" : serverConfig.url ? "http" : null);

  if (type === "sse") {
    if (!serverConfig.url) throw new Error(`MCP server of type "sse" needs a "url".`);
    // SSE keeps a stream open, so it (unlike plain http) can carry
    // server-initiated requests such as sampling.
    return new SseMcpClient({ url: serverConfig.url, headers: serverConfig.headers || {}, onSampling, onElicitation });
  }
  if (type === "http") {
    if (!serverConfig.url) throw new Error(`MCP server of type "http" needs a "url".`);
    return new HttpMcpClient({ url: serverConfig.url, headers: serverConfig.headers || {} });
  }
  if (type !== "stdio") {
    throw new Error(`MCP server config must declare a "command" (stdio) or a "url" (http).`);
  }
  return new McpClient({
    command: serverConfig.command,
    args: serverConfig.args || [],
    cwd,
    env: serverConfig.env || {},
    onSampling,
    onElicitation,
  });
}
