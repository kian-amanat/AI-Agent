/**
 * core/runtime/docker.mjs — execution inside a container.
 *
 * The one design decision that matters here:
 *
 *   FILE OPERATIONS GO THROUGH `docker exec`, NOT THROUGH THE BIND MOUNT.
 *
 * The workspace is bind-mounted, so `fs.readFile(hostPath)` would "work" — the
 * bytes are the same bytes. It would also be a lie. The moment anyone runs
 * without a mount (a copy-in workspace, a read-only mount, a remote Docker
 * host), those host-side calls keep hitting the host while `bash` runs in the
 * container, and Kodo would be reporting "sandboxed" for a configuration where
 * half the tools never entered the sandbox at all.
 *
 * Routing every read and write through `docker exec` means the container's view
 * IS the runtime's view, by construction. It costs a process spawn per file
 * operation. That is the correct trade: an agent doing tens of file operations
 * per task pays milliseconds, and in exchange "sandboxed" means what it says.
 * `tests/dockerRuntime.test.mjs` proves it by creating files that exist only
 * inside the container and only on the host, and checking which ones each side
 * can see.
 *
 * Security posture of the container Kodo starts:
 *   --network none by default   the agent cannot exfiltrate or fetch
 *   --cap-drop ALL              no capabilities it does not need
 *   --security-opt no-new-privileges
 *   --pids-limit / --memory     a runaway build cannot take the host down
 *   non-root user               root inside would write root-owned files into
 *                               a bind-mounted workspace, which the user then
 *                               cannot delete without sudo
 */

import { spawn } from "child_process";
import path from "path";
import crypto from "crypto";

import { toRelativePosix } from "./contract.mjs";
import { IGNORE_DIRS, CODE_EXTENSIONS, shellQuote } from "./host.mjs";
import { CONTAINER_WORKTREE_ROOT, createContainerWorktree, removeContainerWorktree } from "./container-worktree.mjs";

const MAX_OUTPUT_CHARS = 60_000;
const WORKDIR = "/workspace";
const DEFAULT_IMAGE = "node:22-bookworm-slim";

/** Run a docker CLI command on the host. Never takes agent-controlled argv. */
function docker(args, { input = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
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

    if (input !== null) { child.stdin.write(input); }
    child.stdin.end();
  });
}

export async function dockerAvailable() {
  const res = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 8000 });
  return res.exit_code === 0;
}

export class DockerRuntime {
  /**
   * @param {object} options
   * @param {string} options.root          host workspace path
   * @param {string} [options.image]
   * @param {boolean} [options.network]    false (default) means --network none
   * @param {boolean} [options.mountWorkspace] true (default) bind-mounts the
   *        workspace so edits persist. false gives a throwaway container whose
   *        changes vanish — which is also how the isolation tests prove that
   *        file operations are genuinely container-side.
   */
  constructor({
    root,
    image = process.env.KODO_DOCKER_IMAGE || DEFAULT_IMAGE,
    network = false,
    mountWorkspace = true,
    memory = "2g",
    pidsLimit = 512,
    containerName = null,
  } = {}) {
    if (!root) throw new Error("DockerRuntime requires a workspace root");
    this.name = "docker";
    this.isolated = true;
    this.root = root;
    this.image = image;
    this.network = network;
    this.mountWorkspace = mountWorkspace;
    this.memory = memory;
    this.pidsLimit = pidsLimit;
    this.containerName = containerName || `kodo-${crypto.randomBytes(6).toString("hex")}`;
    this.containerId = null;
    this.workdir = WORKDIR;
    this.backgroundTasks = new Map();
    this._worktrees = new Map();
    this._taskCounter = 0;
    this._grepTool = null;
    this._owned = true;
  }

  async start() {
    if (this.containerId) return;

    if (!(await dockerAvailable())) {
      throw new Error(
        "Docker is not available (the daemon is not running, or the CLI is not installed). " +
        "Kodo will not fall back to host execution when a sandbox was requested.",
      );
    }

    const args = [
      "run", "--detach",
      "--name", this.containerName,
      "--workdir", this.workdir,
      // A container the agent cannot escalate inside.
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.pidsLimit),
      // Override any ENTRYPOINT the image declares. Kodo needs a shell it can
      // exec into, and an image whose entrypoint is a specific binary (git,
      // node, a linter) would otherwise receive the keep-alive command as
      // arguments to THAT program — the container exits immediately and the
      // failure reads as "the sandbox did not start" rather than "this image
      // has an entrypoint".
      "--entrypoint", "sh",
      "--memory", this.memory,
      // No network unless explicitly asked for. An agent that cannot reach the
      // network cannot exfiltrate the code it is reading.
      ...(this.network ? [] : ["--network", "none"]),
    ];

    if (this.mountWorkspace) {
      args.push("--volume", `${this.root}:${this.workdir}`);
    }

    // Keep it alive; the agent's work arrives via `docker exec`.
    args.push(this.image, "-c", "while true; do sleep 3600; done");

    const created = await docker(args, { timeoutMs: 180_000 });
    if (created.exit_code !== 0) {
      throw new Error(`Could not start the Kodo container: ${created.stderr.trim() || `docker run exited ${created.exit_code}`}`);
    }
    this.containerId = created.stdout.trim();

    if (!this.mountWorkspace) {
      // No mount: the workspace has to be copied in, or the container starts
      // empty and every read returns null — which would look like "the agent
      // cannot see the project" rather than a configuration mistake.
      await docker(["cp", `${this.root}/.`, `${this.containerId}:${this.workdir}`], { timeoutMs: 180_000 });
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

    // Same container, same background-task registry, different working directory.
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
    if (!this.containerId || !this._owned) return;
    // force-remove: SIGKILL and delete. The container holds nothing we need
    // once the run is over — the workspace edits are on the bind mount.
    await docker(["rm", "--force", this.containerId], { timeoutMs: 30_000 });
    this.containerId = null;
    this.backgroundTasks.clear();
  }

  /**
   * Prove, right now, that this runtime confines BOTH file and process
   * operations. `--sandbox` gates on this: a runtime that cannot demonstrate
   * isolation refuses to run rather than degrading to the host.
   *
   * Deliberately empirical. Checking "did we pass --network none" only proves
   * we intended isolation; writing a file and looking for it on the host proves
   * we achieved it.
   */
  async verifyIsolation() {
    const checks = [];
    const fail = (reason) => ({ isolated: false, checks, reason });

    if (!this.containerId) return fail("the container is not running");

    // 1. Processes execute inside the container.
    const hostname = await this.exec("cat /proc/sys/kernel/hostname", { timeoutMs: 15_000 });
    const shortId = this.containerId.slice(0, 12);
    if (hostname.exit_code !== 0) return fail(`could not run a command in the container: ${hostname.stderr.trim()}`);
    if (!hostname.stdout.trim().startsWith(shortId.slice(0, 6))) {
      // Docker defaults the hostname to the container id. If what answered is
      // not the container, something is proxying execution elsewhere.
      return fail(`a command ran, but not inside the expected container (hostname "${hostname.stdout.trim()}")`);
    }
    checks.push(`processes execute in container ${shortId}`);

    // 2. The container has its own PID namespace — it must not see host PIDs.
    const pids = await this.exec("ls /proc | grep -c '^[0-9]*$'", { timeoutMs: 15_000 });
    const pidCount = Number(pids.stdout.trim());
    if (!Number.isFinite(pidCount) || pidCount > 50) {
      return fail(`the container sees ${pidCount} processes — that is the host PID namespace, not an isolated one`);
    }
    checks.push(`isolated PID namespace (${pidCount} processes visible)`);

    // 3. File writes go into the container, not around it. Written through the
    //    runtime, read back through the runtime, and — the actual proof — the
    //    container is asked whether a path that exists ONLY on the host is
    //    visible to it.
    const probeRel = `.kodo-isolation-${crypto.randomBytes(4).toString("hex")}`;
    const marker = crypto.randomBytes(8).toString("hex");
    await this.writeFile(probeRel, marker);
    const readBack = await this.readFile(probeRel);
    if (readBack?.trim() !== marker) {
      return fail("a file written through the runtime could not be read back through it");
    }
    await this.deleteFile(probeRel);
    checks.push("file writes and reads execute inside the container");

    // 4. The host filesystem outside the workspace is not reachable.
    const hostProbe = await this.exec(`test -e ${shellQuote(this.root)} && echo VISIBLE || echo HIDDEN`, { timeoutMs: 15_000 });
    if (hostProbe.stdout.includes("VISIBLE") && this.root !== this.workdir) {
      return fail(`the host workspace path ${this.root} is visible inside the container at its host location — the filesystem is not namespaced`);
    }
    checks.push("the host filesystem layout is not visible inside the container");

    // 5. Network, when it was supposed to be off.
    if (!this.network) {
      const net = await this.exec("cat /proc/net/route | wc -l", { timeoutMs: 15_000 });
      const routes = Number(net.stdout.trim());
      // A --network none container has only the header line.
      if (Number.isFinite(routes) && routes > 1) {
        return fail("the container has network routes despite --network none");
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

  /** Run a shell command in the container. */
  _exec(command, { timeoutMs = 120_000, cwd = null, input = null } = {}) {
    if (!this.containerId) return Promise.resolve({ exit_code: null, stdout: "", stderr: "the Kodo container is not running" });
    const args = ["exec", "--interactive", "--workdir", cwd ? this._containerPath(cwd) : this.workdir];
    args.push(this.containerId, "sh", "-c", command);
    return docker(args, { timeoutMs, input });
  }

  // ── Filesystem — every one of these executes IN the container ──────────────

  async stat(rel) {
    const target = shellQuote(this._containerPath(rel));
    // One round trip: type and size together.
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

  /**
   * Written by streaming the content into `cat` over stdin, not by embedding it
   * in a shell command. Content comes from a model and can contain anything —
   * quotes, newlines, `$(...)`. Interpolating it into a command line would be a
   * shell-injection hole with the agent on the wrong side of it.
   */
  async writeFile(rel, content) {
    const target = this._containerPath(rel);
    const dir = path.posix.dirname(target);
    const res = await this._exec(
      `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(`${target}.kodo.tmp`)} && mv ${shellQuote(`${target}.kodo.tmp`)} ${shellQuote(target)}`,
      { input: String(content), timeoutMs: 60_000 },
    );
    if (res.exit_code !== 0) {
      throw new Error(`write failed inside the container: ${res.stderr.trim() || `exit ${res.exit_code}`}`);
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
      // Match HostRuntime's filter exactly: directories, plus files with a
      // recognised code extension. Two different answers for "what is in this
      // project" depending on runtime would be its own bug.
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
      // `find … -prune | xargs grep`, not `grep -r --exclude-dir`.
      //
      // --exclude-dir is a GNU extension. Container base images are routinely
      // Alpine/BusyBox, whose grep silently rejects it — the whole command
      // fails and `grep` returns "no matches", which reads as "your search term
      // isn't in this project" rather than "search is broken in the sandbox".
      // find+xargs is POSIX and behaves identically on both.
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

  /**
   * Background work runs inside the container too, with its output file inside
   * the container. Tracking a host PID here would mean `kill_shell` signalled
   * the `docker exec` client rather than the process doing the work — the
   * container process would survive, and Kodo would report it stopped.
   */
  async execBackground(command, { cwd = null } = {}) {
    const id = `bg_${Date.now().toString(36)}_${++this._taskCounter}`;
    const outDir = `${this.workdir}/.kodo/tasks`;
    const outputFile = `${outDir}/${id}.output`;
    const pidFile = `${outDir}/${id}.pid`;

    // Sequenced with `;` and grouped with braces, NOT chained with `&&`.
    // In `a && b && c & d`, the `&` backgrounds the entire `a && b && c` list
    // and runs `d` immediately in parallel — so `echo $! > pidfile` fired
    // before `mkdir -p` had created the directory, and `$!` referred to
    // nothing. The braces keep the launch and the pid capture together in the
    // foreground, with only the command itself backgrounded.
    const launch =
      `mkdir -p ${shellQuote(outDir)}; ` +
      `cd ${shellQuote(cwd ? this._containerPath(cwd) : this.workdir)}; ` +
      `{ nohup sh -c ${shellQuote(command)} > ${shellQuote(outputFile)} 2>&1 & ` +
      `echo $! > ${shellQuote(pidFile)}; }`;

    const res = await this._exec(launch, { timeoutMs: 30_000 });
    if (res.exit_code !== 0) {
      throw new Error(`could not start a background task in the container: ${res.stderr.trim()}`);
    }

    this.backgroundTasks.set(id, {
      id, command, outputFile, pidFile, startedAt: Date.now(),
    });
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
    const status = (statusLine || "").trim() === "running" ? "running" : "exited";
    return {
      success: true,
      task_id: id,
      command: task.command,
      status,
      exit_code: null,   // the container's shell does not retain it after detach
      output: String(output || "").slice(-MAX_OUTPUT_CHARS),
    };
  }

  killBackground(id) {
    const task = this.backgroundTasks.get(id);
    if (!task) {
      return { success: false, error: `No background task "${id}" — check the id, or it may have already exited and been cleaned up.` };
    }
    // Fire-and-forget to keep the signature synchronous, matching HostRuntime.
    void this._exec(
      `if [ -f ${shellQuote(task.pidFile)} ]; then kill -TERM "$(cat ${shellQuote(task.pidFile)})" 2>/dev/null || true; fi`,
      { timeoutMs: 15_000 },
    );
    return { success: true, message: `Sent a stop signal to task ${id} (${task.command.slice(0, 80)}) inside the container.` };
  }
}

export function createDockerRuntime(options) {
  return new DockerRuntime(options);
}
