/**
 * core/runtime/incus.mjs — execution inside an Incus system container.
 *
 * Structurally identical to DockerRuntime, and for the same reason: every file
 * operation goes through `incus exec`, never through a host path. Incus's
 * `incus file push/pull` would be the obvious way to move file content, and it
 * is deliberately NOT used for reads and writes — it is a host-side transfer
 * API, and building the file tools on it would put the "is this really inside
 * the container" question back into the same ambiguous place the bind-mount
 * shortcut does in Docker. `exec` leaves no ambiguity.
 *
 * ── Verification status ──────────────────────────────────────────────────────
 *
 * This implementation has NOT been executed against a live Incus daemon.
 * Incus was not installed on the machine where it was written, so
 * `tests/incusRuntime.test.mjs` skips there rather than passing vacuously.
 *
 * That is safe, and it is safe by construction rather than by promise:
 * `createRuntime()` refuses to start any sandbox whose `verifyIsolation()` does
 * not return `isolated: true`, and this class's `verifyIsolation()` performs the
 * same empirical checks as the Docker one — write a file and read it back,
 * count visible processes, confirm the host filesystem is unreachable. So on a
 * machine without a working Incus, `--sandbox incus` fails closed with a real
 * error. It cannot silently execute on the host.
 *
 * Treat this file as reviewed-but-unproven until those tests have run green
 * somewhere with Incus installed. See docs/sandboxing.md.
 */

import { spawn } from "child_process";
import path from "path";
import crypto from "crypto";

import { toRelativePosix } from "./contract.mjs";
import { IGNORE_DIRS, CODE_EXTENSIONS, shellQuote } from "./host.mjs";
import { CONTAINER_WORKTREE_ROOT, createContainerWorktree, removeContainerWorktree } from "./container-worktree.mjs";

const MAX_OUTPUT_CHARS = 60_000;
const WORKDIR = "/workspace";
const DEFAULT_IMAGE = "images:debian/12";

/** Run an incus CLI command on the host. Never takes agent-controlled argv. */
function incus(args, { input = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("incus", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { if (stdout.length < 4_000_000) stdout += d.toString(); });
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
        stdout,
        stderr,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: null, stdout: "", stderr: err.message });
    });

    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

export async function incusAvailable() {
  const res = await incus(["info"], { timeoutMs: 8000 });
  return res.exit_code === 0;
}

export class IncusRuntime {
  constructor({
    root,
    image = process.env.KODO_INCUS_IMAGE || DEFAULT_IMAGE,
    network = false,
    mountWorkspace = true,
    instanceName = null,
  } = {}) {
    if (!root) throw new Error("IncusRuntime requires a workspace root");
    this.name = "incus";
    this.isolated = true;
    this.root = root;
    this.image = image;
    this.network = network;
    this.mountWorkspace = mountWorkspace;
    this.instance = instanceName || `kodo-${crypto.randomBytes(6).toString("hex")}`;
    this.started = false;
    this.workdir = WORKDIR;
    this.backgroundTasks = new Map();
    this._worktrees = new Map();
    this._taskCounter = 0;
    this._grepTool = null;
  }

  async start() {
    if (this.started) return;

    if (!(await incusAvailable())) {
      throw new Error(
        "Incus is not available (the daemon is not running, or the CLI is not installed). " +
        "Kodo will not fall back to host execution when a sandbox was requested.",
      );
    }

    const launched = await incus(["launch", this.image, this.instance], { timeoutMs: 300_000 });
    if (launched.exit_code !== 0) {
      throw new Error(`Could not launch the Kodo Incus instance: ${launched.stderr.trim() || `exit ${launched.exit_code}`}`);
    }
    this.started = true;

    // Wait for the instance to actually be usable — `launch` returns as soon as
    // the container is created, before its init has finished, and the first
    // exec would otherwise fail with a confusing error.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const probe = await incus(["exec", this.instance, "--", "true"], { timeoutMs: 10_000 });
      if (probe.exit_code === 0) break;
      if (Date.now() > deadline) {
        await this.cleanup().catch(() => {});
        throw new Error("The Incus instance did not become ready within 60s.");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!this.network) {
      // Detach the default NIC. An agent that cannot reach the network cannot
      // exfiltrate the code it is reading.
      await incus(["config", "device", "add", this.instance, "eth0", "none"], { timeoutMs: 30_000 });
    }

    await incus(["exec", this.instance, "--", "mkdir", "-p", this.workdir], { timeoutMs: 30_000 });

    if (this.mountWorkspace) {
      const added = await incus([
        "config", "device", "add", this.instance, "workspace", "disk",
        `source=${this.root}`, `path=${this.workdir}`,
      ], { timeoutMs: 30_000 });
      if (added.exit_code !== 0) {
        await this.cleanup().catch(() => {});
        throw new Error(
          `Could not mount the workspace into the Incus instance: ${added.stderr.trim()}. ` +
          "Unprivileged Incus containers often need idmap configuration for host bind mounts.",
        );
      }
    } else {
      const pushed = await incus(
        ["file", "push", "--recursive", `${this.root}/.`, `${this.instance}${this.workdir}/`],
        { timeoutMs: 300_000 },
      );
      if (pushed.exit_code !== 0) {
        await this.cleanup().catch(() => {});
        throw new Error(`Could not copy the workspace into the Incus instance: ${pushed.stderr.trim()}`);
      }
    }
  }

  /**
   * A runtime rooted at a different path INSIDE this sandbox.
   *
   * This used to refuse outright, because the only caller was worktree
   * isolation and worktrees were created on the host — a path this runtime
   * genuinely could not reach. Now that createWorktree() makes the checkout
   * inside the sandbox, re-rooting is both possible and correct, and a
   * sub-agent inherits its parent's confinement instead of losing it.
   *
   * A path outside the sandbox is still refused: returning a host runtime here
   * is exactly the escape this layer exists to prevent.
   */
  derive(root) {
    const target = String(root || "");
    const reachable = target === this.workdir
      || target.startsWith(`${this.workdir}/`)
      || target.startsWith(`${CONTAINER_WORKTREE_ROOT}/`);

    if (!reachable) {
      throw new Error(
        `${this.constructor.name} cannot derive a runtime for "${target}": it is outside the sandbox. ` +
        "Returning a host runtime here would let a sub-agent escape its parent's sandbox.",
      );
    }

    // Same instance, same background-task registry, different working directory.
    const derived = Object.create(Object.getPrototypeOf(this));
    Object.assign(derived, this, { workdir: target, _owned: false, backgroundTasks: new Map() });
    return derived;
  }

  // ── Worktrees — created INSIDE the sandbox ─────────────────────────────────

  worktreeRoot() {
    return CONTAINER_WORKTREE_ROOT;
  }

  async createWorktree(options) {
    const result = await createContainerWorktree(this, options);
    if (result.ok) this._worktrees.set(result.worktree.worktreeId, result.worktree);
    return result;
  }

  async removeWorktree(worktreeId) {
    return removeContainerWorktree(this, this._worktrees, worktreeId);
  }

  async cleanup() {
    if (!this.started) return;
    await incus(["delete", "--force", this.instance], { timeoutMs: 60_000 });
    this.started = false;
    this.backgroundTasks.clear();
  }

  /**
   * The same empirical checks DockerRuntime performs. `createRuntime()` refuses
   * to run unless this returns isolated:true, which is what makes shipping an
   * unproven implementation safe rather than reckless.
   */
  async verifyIsolation() {
    const checks = [];
    const fail = (reason) => ({ isolated: false, checks, reason });

    if (!this.started) return fail("the instance is not running");

    const hostname = await this.exec("cat /proc/sys/kernel/hostname", { timeoutMs: 15_000 });
    if (hostname.exit_code !== 0) return fail(`could not run a command in the instance: ${hostname.stderr.trim()}`);
    if (hostname.stdout.trim() !== this.instance) {
      return fail(`a command ran, but not inside the expected instance (hostname "${hostname.stdout.trim()}", expected "${this.instance}")`);
    }
    checks.push(`processes execute in instance ${this.instance}`);

    const pids = await this.exec("ls /proc | grep -c '^[0-9]*$'", { timeoutMs: 15_000 });
    const pidCount = Number(pids.stdout.trim());
    if (!Number.isFinite(pidCount) || pidCount > 100) {
      return fail(`the instance sees ${pidCount} processes — that looks like the host PID namespace`);
    }
    checks.push(`isolated PID namespace (${pidCount} processes visible)`);

    const probeRel = `.kodo-isolation-${crypto.randomBytes(4).toString("hex")}`;
    const marker = crypto.randomBytes(8).toString("hex");
    await this.writeFile(probeRel, marker);
    const readBack = await this.readFile(probeRel);
    if (readBack?.trim() !== marker) {
      return fail("a file written through the runtime could not be read back through it");
    }
    await this.deleteFile(probeRel);
    checks.push("file writes and reads execute inside the instance");

    const hostProbe = await this.exec(
      `test -e ${shellQuote(this.root)} && echo VISIBLE || echo HIDDEN`,
      { timeoutMs: 15_000 },
    );
    if (hostProbe.stdout.includes("VISIBLE") && this.root !== this.workdir) {
      return fail(`the host workspace path ${this.root} is visible at its host location inside the instance`);
    }
    checks.push("the host filesystem layout is not visible inside the instance");

    if (!this.network) {
      const net = await this.exec("cat /proc/net/route | wc -l", { timeoutMs: 15_000 });
      const routes = Number(net.stdout.trim());
      if (Number.isFinite(routes) && routes > 1) {
        return fail("the instance has network routes despite the NIC being detached");
      }
      checks.push("no network access");
    }

    return { isolated: true, checks };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _containerPath(rel) {
    const clean = toRelativePosix(rel);
    return clean ? `${this.workdir}/${clean}` : this.workdir;
  }

  _exec(command, { timeoutMs = 120_000, cwd = null, input = null } = {}) {
    if (!this.started) {
      return Promise.resolve({ exit_code: null, stdout: "", stderr: "the Kodo Incus instance is not running" });
    }
    const dir = cwd ? this._containerPath(cwd) : this.workdir;
    return incus(
      ["exec", this.instance, "--", "sh", "-c", `cd ${shellQuote(dir)} 2>/dev/null; ${command}`],
      { timeoutMs, input },
    );
  }

  // ── Filesystem — all of it executes IN the instance ────────────────────────

  async stat(rel) {
    const target = shellQuote(this._containerPath(rel));
    const res = await this._exec(
      `if [ -f ${target} ]; then echo "f $(wc -c < ${target})"; elif [ -d ${target} ]; then echo "d 0"; else echo "x 0"; fi`,
      { timeoutMs: 15_000 },
    );
    const [kind, size] = res.stdout.trim().split(/\s+/);
    if (kind === "f") return { isFile: true, isDirectory: false, size: Number(size) || 0 };
    if (kind === "d") return { isFile: false, isDirectory: true, size: 0 };
    return null;
  }

  async readFile(rel, maxBytes = 400_000) {
    const stat = await this.stat(rel);
    if (!stat?.isFile) return null;
    const target = shellQuote(this._containerPath(rel));
    if (stat.size > maxBytes) {
      const res = await this._exec(`head -c ${maxBytes} ${target}`, { timeoutMs: 60_000 });
      if (res.exit_code !== 0) return null;
      return `${res.stdout}\n\n... [truncated at ${maxBytes} bytes — use start_line/end_line to read more]`;
    }
    const res = await this._exec(`cat ${target}`, { timeoutMs: 60_000 });
    return res.exit_code === 0 ? res.stdout : null;
  }

  /** Streamed over stdin — model-authored content is never interpolated into a shell command. */
  async writeFile(rel, content) {
    const target = this._containerPath(rel);
    const dir = path.posix.dirname(target);
    const res = await this._exec(
      `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(`${target}.kodo.tmp`)} && mv ${shellQuote(`${target}.kodo.tmp`)} ${shellQuote(target)}`,
      { input: String(content), timeoutMs: 60_000 },
    );
    if (res.exit_code !== 0) {
      throw new Error(`write failed inside the instance: ${res.stderr.trim() || `exit ${res.exit_code}`}`);
    }
  }

  async deleteFile(rel) {
    const res = await this._exec(`rm -f ${shellQuote(this._containerPath(rel))}`, { timeoutMs: 15_000 });
    return res.exit_code === 0;
  }

  async walk(rel = "", maxDepth = 8) {
    const base = this._containerPath(rel);
    const prunes = [...IGNORE_DIRS].map((d) => `-name ${shellQuote(d)}`).join(" -o ");
    const cmd =
      `cd ${shellQuote(base)} 2>/dev/null && ` +
      `find . -mindepth 1 -maxdepth ${maxDepth + 1} \\( ${prunes} \\) -prune -o -print0 | ` +
      `xargs -0 -r sh -c 'for p; do if [ -d "$p" ]; then echo "d $p"; else echo "f $p"; fi; done' _`;

    const res = await this._exec(cmd, { timeoutMs: 60_000 });
    if (res.exit_code !== 0) return [];

    const out = [];
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const isDir = trimmed.startsWith("d ");
      const p = trimmed.slice(2).replace(/^\.\//, "");
      if (!p) continue;
      if (isDir) out.push({ path: p, isDir: true });
      else if (CODE_EXTENSIONS.has(path.posix.extname(p).toLowerCase())) out.push({ path: p, isDir: false });
    }
    return out;
  }

  async grep(pattern, fileGlob = null) {
    if (this._grepTool === null) {
      const probe = await this._exec("command -v rg >/dev/null 2>&1 && echo rg || echo grep", { timeoutMs: 15_000 });
      this._grepTool = probe.stdout.trim() === "rg" ? "rg" : "grep";
    }
    const excludes = [...IGNORE_DIRS];
    let cmd;
    if (this._grepTool === "rg") {
      const globArg = fileGlob ? ` -g ${shellQuote(fileGlob)}` : "";
      cmd = `rg -n --no-heading -S -m 200 --max-columns 240 ${excludes.map((d) => `-g '!${d}'`).join(" ")}${globArg} ${shellQuote(pattern)} .`;
    } else {
      // POSIX find+xargs rather than GNU --exclude-dir; see DockerRuntime.grep
      // for why (minimal container images ship BusyBox grep).
      const prunes = excludes.map((d) => `-name ${shellQuote(d)}`).join(" -o ");
      const nameFilter = fileGlob ? ` -name ${shellQuote(fileGlob)}` : "";
      cmd =
        `find . \\( ${prunes} \\) -prune -o -type f${nameFilter} -print0 | ` +
        `xargs -0 -r grep -n -i ${shellQuote(pattern)} /dev/null | head -200`;
    }
    const res = await this._exec(cmd, { timeoutMs: 30_000 });
    const lines = (res.stdout || "").split("\n").filter(Boolean).slice(0, 120);
    return { matches: lines, count: lines.length };
  }

  // ── Process ────────────────────────────────────────────────────────────────

  async exec(command, { cwd = null, timeoutMs = 120_000 } = {}) {
    const res = await this._exec(command, { cwd, timeoutMs });
    return {
      exit_code: res.exit_code,
      timed_out: Boolean(res.timed_out),
      stdout: String(res.stdout).slice(0, MAX_OUTPUT_CHARS / 2),
      stderr: String(res.stderr).slice(0, MAX_OUTPUT_CHARS / 2),
    };
  }

  async execBackground(command, { cwd = null } = {}) {
    const id = `bg_${Date.now().toString(36)}_${++this._taskCounter}`;
    const outDir = `${this.workdir}/.kodo/tasks`;
    const outputFile = `${outDir}/${id}.output`;
    const pidFile = `${outDir}/${id}.pid`;

    // Braces, not `&&` chaining — see DockerRuntime.execBackground for the
    // precedence bug that shape avoids.
    const launch =
      `mkdir -p ${shellQuote(outDir)}; ` +
      `cd ${shellQuote(cwd ? this._containerPath(cwd) : this.workdir)}; ` +
      `{ nohup sh -c ${shellQuote(command)} > ${shellQuote(outputFile)} 2>&1 & ` +
      `echo $! > ${shellQuote(pidFile)}; }`;

    const res = await this._exec(launch, { timeoutMs: 30_000 });
    if (res.exit_code !== 0) {
      throw new Error(`could not start a background task in the instance: ${res.stderr.trim()}`);
    }

    this.backgroundTasks.set(id, { id, command, outputFile, pidFile, startedAt: Date.now() });
    return { id, outputFile: `.kodo/tasks/${id}.output` };
  }

  async readBackgroundOutput(id) {
    const task = this.backgroundTasks.get(id);
    if (!task) {
      return { success: false, error: `No background task "${id}" — check the id, or it may have already exited and been cleaned up.` };
    }
    const res = await this._exec(
      `cat ${shellQuote(task.outputFile)} 2>/dev/null; ` +
      `if [ -f ${shellQuote(task.pidFile)} ] && kill -0 "$(cat ${shellQuote(task.pidFile)})" 2>/dev/null; ` +
      `then echo "__KODO_STATUS__running"; else echo "__KODO_STATUS__exited"; fi`,
      { timeoutMs: 20_000 },
    );
    const [output, statusLine] = String(res.stdout).split("__KODO_STATUS__");
    return {
      success: true,
      task_id: id,
      command: task.command,
      status: (statusLine || "").trim() === "running" ? "running" : "exited",
      exit_code: null,
      output: String(output || "").slice(-MAX_OUTPUT_CHARS),
    };
  }

  killBackground(id) {
    const task = this.backgroundTasks.get(id);
    if (!task) {
      return { success: false, error: `No background task "${id}" — check the id, or it may have already exited and been cleaned up.` };
    }
    void this._exec(
      `if [ -f ${shellQuote(task.pidFile)} ]; then kill -TERM "$(cat ${shellQuote(task.pidFile)})" 2>/dev/null || true; fi`,
      { timeoutMs: 15_000 },
    );
    return { success: true, message: `Sent a stop signal to task ${id} (${task.command.slice(0, 80)}) inside the instance.` };
  }
}

export function createIncusRuntime(options) {
  return new IncusRuntime(options);
}
