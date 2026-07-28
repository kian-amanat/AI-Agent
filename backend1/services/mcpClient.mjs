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
  constructor({ command, args = [], cwd, env = {} }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.extraEnv = env;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.ready = null;
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
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...sanitizedChildEnv(), ...this.extraEnv },
      detached: process.platform !== "win32",
    });
    this.child.unref?.();

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this._handleLine(line));

    // Kept only for surfacing IN an exit/error rejection — an MCP server
    // that fails to start (missing browser binary, bad args, wrong cwd) logs
    // the real reason here, and a bare "exited code 1" with nothing else is
    // nearly undebuggable.
    let stderrTail = "";
    this.child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    this.child.on("exit", (code) => {
      const detail = stderrTail.trim() ? `\n${stderrTail.trim().slice(-500)}` : "";
      const err = new Error(`MCP server "${this.command}" exited (code ${code}) before responding.${detail}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    const initResult = await this._request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "kodo", version: "1.0.0" },
    });
    this._notify("notifications/initialized", {});
    return initResult;
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON noise on stdout
    if (msg.id === undefined || !this.pending.has(msg.id)) return; // notification, not a reply we're waiting on
    const { resolve, reject } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "MCP error"));
    else resolve(msg.result);
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

// One client instance per (serverName, cwd) — called lazily by the tool
// executor the first time a run actually needs it.
export function spawnMcpServer(serverConfig, cwd) {
  return new McpClient({
    command: serverConfig.command,
    args: serverConfig.args || [],
    cwd,
    env: serverConfig.env || {},
  });
}
