/**
 * core/runtime/host.mjs — the default runtime: this machine, no confinement.
 *
 * The method bodies here are the agent loop's existing filesystem and process
 * helpers, MOVED rather than rewritten. That is deliberate and load-bearing:
 * the point of Phase 1 is that behaviour does not change, and the existing
 * 1000+ assertion suite is the proof. A "tidier" reimplementation would have
 * made that proof meaningless.
 *
 * `isolated` is false, and `verifyIsolation()` says so plainly. HostRuntime is
 * not a weak sandbox — it is no sandbox, which is the correct and expected
 * default for a tool you ran in your own terminal against your own project.
 * Every protection Kodo already had (path confinement, sensitive-file blocking,
 * the bash allowlist, approval gates) still applies above this layer.
 */

import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";

import { sanitizedChildEnv } from "../../utils/process.util.mjs";
import { toRelativePosix } from "./contract.mjs";
import { WORKTREE_ROOT_PATH } from "../../services/worktreeManager.mjs";

const MAX_OUTPUT_CHARS = 60_000;

// Kept in sync with agent_loop's own constants — exported so the loop can use
// exactly these rather than keeping a second copy.
export const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo",
  ".cache", "out", ".agent-history", ".kodo", "uploads", "temp_audio",
  ".claude", ".vscode", ".idea",
]);

export const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".json", ".md", ".yaml", ".yml", ".py", ".html", ".txt",
]);

/**
 * Portable shell resolution. A hardcoded "/bin/zsh" only exists on macOS by
 * default and breaks every Linux/CI/Docker deployment outright.
 */
export function resolveShell() {
  if (process.platform === "win32") {
    return { bin: process.env.ComSpec || "cmd.exe", flag: "/c" };
  }
  return { bin: process.env.SHELL || "/bin/bash", flag: "-c" };
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export class HostRuntime {
  /**
   * @param {{root: string}} options workspace root, an absolute host path
   */
  constructor({ root }) {
    if (!root) throw new Error("HostRuntime requires a workspace root");
    this.name = "host";
    this.isolated = false;
    this.root = root;
    this.backgroundTasks = new Map();
    this._taskCounter = 0;
    this._grepTool = null;
  }

  async start() { /* nothing to bring up — it is this machine */ }

  /**
   * A runtime for a different root, used when a sub-agent runs in its own git
   * worktree. On the host any path is reachable, so this is a plain re-root.
   */
  derive(root) {
    return new HostRuntime({ root });
  }

  async cleanup() {
    // Background tasks outlive a single agent run by design (a dev server the
    // agent started stays up), so this does NOT kill them. killBackground is
    // the explicit way to stop one.
  }

  // ── Worktrees ──────────────────────────────────────────────────────────────
  // Delegates to services/worktreeManager.mjs, which already owns the registry,
  // the collision-safe ids and the refuses-to-delete-outside-its-prefix guard.
  // This is a re-export through the boundary, not a second implementation.

  worktreeRoot() {
    return WORKTREE_ROOT_PATH;
  }

  async createWorktree({ subagentId, sessionId = null, ref = "HEAD" }) {
    const { createWorktree } = await import("../../services/worktreeManager.mjs");
    return createWorktree({ workspacePath: this.root, subagentId, sessionId, ref });
  }

  async removeWorktree(worktreeId) {
    const { removeWorktree } = await import("../../services/worktreeManager.mjs");
    return removeWorktree(worktreeId);
  }

  /**
   * HostRuntime confines nothing and says so. Reporting a soft "partially
   * isolated" here is exactly the lie this whole refactor exists to prevent:
   * `--sandbox` gates on this answer, so anything but a flat false would let
   * host execution ship under a sandbox flag.
   */
  async verifyIsolation() {
    return {
      isolated: false,
      checks: ["host runtime — no confinement: files and processes are on this machine"],
      reason: "HostRuntime executes directly on the host by design.",
    };
  }

  /** Absolute host path for a workspace-relative one. Confinement is enforced above. */
  _abs(rel) {
    return path.resolve(this.root, toRelativePosix(rel));
  }

  // ── Filesystem ─────────────────────────────────────────────────────────────

  async stat(rel) {
    try {
      const s = await fs.stat(this._abs(rel));
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  }

  async readFile(rel, maxBytes = 400_000) {
    const absPath = this._abs(rel);
    try {
      const stat = await this.stat(rel);
      if (!stat?.isFile) return null;
      if (stat.size > maxBytes) {
        const fd = await fs.open(absPath, "r");
        const buf = Buffer.alloc(maxBytes);
        await fd.read(buf, 0, maxBytes, 0);
        await fd.close();
        return `${buf.toString("utf-8")}\n\n... [truncated at ${maxBytes} bytes — use start_line/end_line to read more]`;
      }
      return await fs.readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Atomic write: temp file then rename, so a crash mid-write cannot leave a
   * truncated source file where a valid one used to be.
   */
  async writeFile(rel, content) {
    const absPath = this._abs(rel);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const tmpPath = `${absPath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, absPath);
  }

  async deleteFile(rel) {
    try {
      await fs.rm(this._abs(rel), { force: false });
      return true;
    } catch {
      return false;
    }
  }

  async walk(rel = "", maxDepth = 8) {
    const base = this._abs(rel);
    const walkDir = async (dir, depth) => {
      const results = [];
      if (depth > maxDepth) return results;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return results; }

      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (entry.isDirectory()) {
          results.push({ path: entry.name, isDir: true });
          const children = await walkDir(abs, depth + 1);
          results.push(...children.map((c) => ({ ...c, path: `${entry.name}/${c.path}` })));
        } else if (CODE_EXTENSIONS.has(ext)) {
          results.push({ path: entry.name, isDir: false });
        }
      }
      return results;
    };
    return walkDir(base, 0);
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async _detectGrepTool() {
    if (this._grepTool) return this._grepTool;
    const probeCmd = process.platform === "win32" ? "where rg" : "which rg";
    const probe = await this.exec(probeCmd, { timeoutMs: 5000 });
    this._grepTool = probe.exit_code === 0 ? "rg" : "grep";
    return this._grepTool;
  }

  async grep(pattern, fileGlob = null) {
    const tool = await this._detectGrepTool();
    const excludes = [...IGNORE_DIRS];
    let cmd;
    if (tool === "rg") {
      const globArg = fileGlob ? ` -g ${shellQuote(fileGlob)}` : "";
      cmd = `rg -n --no-heading -S -m 200 --max-columns 240 ${excludes.map((d) => `-g '!${d}'`).join(" ")}${globArg} ${shellQuote(pattern)} .`;
    } else {
      const includeArg = fileGlob ? ` --include=${shellQuote(fileGlob)}` : "";
      cmd = `grep -rn -i ${excludes.map((d) => `--exclude-dir=${d}`).join(" ")}${includeArg} ${shellQuote(pattern)} . | head -200`;
    }
    const res = await this.exec(cmd, { timeoutMs: 20_000 });
    const lines = (res.stdout || "").split("\n").filter(Boolean).slice(0, 120);
    return { matches: lines, count: lines.length };
  }

  // ── Process ────────────────────────────────────────────────────────────────

  /**
   * Child processes must not inherit the server's secrets. An allowlisted npm
   * script or postinstall hook would otherwise see OPENAI_API_KEY and could
   * exfiltrate it — see utils/process.util.mjs.
   */
  exec(command, { cwd = null, timeoutMs = 120_000 } = {}) {
    return new Promise((resolve) => {
      const { bin, flag } = resolveShell();
      const child = spawn(bin, [flag, command], {
        cwd: cwd ? this._abs(cwd) : this.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedChildEnv(),
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { if (stdout.length < 200_000) stdout += d.toString(); });
      child.stderr.on("data", (d) => { if (stderr.length < 200_000) stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exit_code: code,
          timed_out: signal === "SIGTERM" || signal === "SIGKILL",
          stdout: stdout.slice(0, MAX_OUTPUT_CHARS / 2),
          stderr: stderr.slice(0, MAX_OUTPUT_CHARS / 2),
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exit_code: null, stdout, stderr: `${stderr}\n${err.message}`.trim() });
      });
    });
  }

  _nextTaskId() {
    this._taskCounter++;
    return `bg_${Date.now().toString(36)}_${this._taskCounter}`;
  }

  /** Bound the registry: evict the oldest EXITED task, never a running one. */
  _pruneBackgroundTasks() {
    if (this.backgroundTasks.size < 20) return;
    for (const [id, task] of this.backgroundTasks) {
      if (task.status === "exited") { this.backgroundTasks.delete(id); return; }
    }
  }

  async execBackground(command, { cwd = null } = {}) {
    const tasksDir = path.join(this.root, ".kodo", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    const id = this._nextTaskId();
    const outputFile = path.join(tasksDir, `${id}.output`);
    await fs.writeFile(outputFile, "");

    const { bin, flag } = resolveShell();
    const child = spawn(bin, [flag, command], {
      cwd: cwd ? this._abs(cwd) : this.root,
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedChildEnv(),
      // Own process group, so killBackground can stop the whole tree
      // (e.g. npm and the vite it spawned).
      detached: process.platform !== "win32",
    });
    child.unref();

    const appendOutput = (buf) => { fs.appendFile(outputFile, buf.toString()).catch(() => {}); };
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);

    this._pruneBackgroundTasks();
    const task = { id, command, child, startedAt: Date.now(), outputFile, status: "running", exitCode: null };
    child.on("close", (code) => { task.status = "exited"; task.exitCode = code; });
    child.on("error", (err) => { task.status = "exited"; appendOutput(`\n[process error: ${err.message}]\n`); });
    this.backgroundTasks.set(id, task);

    return { id, outputFile: path.relative(this.root, outputFile) };
  }

  async readBackgroundOutput(id) {
    const task = this.backgroundTasks.get(id);
    if (!task) {
      return { success: false, error: `No background task "${id}" — check the id, or it may have already exited and been cleaned up.` };
    }
    let output = "";
    try { output = await fs.readFile(task.outputFile, "utf-8"); } catch { /* not written yet */ }
    return {
      success: true,
      task_id: id,
      command: task.command,
      status: task.status,
      exit_code: task.exitCode,
      output: output.slice(-MAX_OUTPUT_CHARS),
    };
  }

  killBackground(id) {
    const task = this.backgroundTasks.get(id);
    if (!task) {
      return { success: false, error: `No background task "${id}" — check the id, or it may have already exited and been cleaned up.` };
    }
    if (task.status === "exited") {
      return { success: true, message: `Task ${id} (${task.command.slice(0, 80)}) had already exited (exit code ${task.exitCode}).` };
    }
    try {
      if (process.platform === "win32") task.child.kill();
      else process.kill(-task.child.pid, "SIGTERM");   // negative pid: whole group
    } catch {
      try { task.child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    return { success: true, message: `Sent a stop signal to task ${id} (${task.command.slice(0, 80)}).` };
  }
}

export function createHostRuntime(options) {
  return new HostRuntime(options);
}
