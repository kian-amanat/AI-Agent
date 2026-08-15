/**
 * src/runtime/procinfo.mjs — process and port inspection, per platform.
 *
 * The lifecycle manager must answer two questions before it signals anything:
 *
 *   1. Is PID N still alive?
 *   2. Is PID N still the process we recorded, or has the OS reused the number?
 *
 * Getting (2) wrong means killing a stranger's process, so "we cannot tell" has
 * to be a distinct answer from "no" — and neither may be silently treated as
 * "yes".
 *
 * POSIX answers with lsof (who holds the port) and ps (what is that PID
 * running). Windows has neither, and previously fell through to "not ours",
 * which reported a PID collision that had not happened and left servers
 * running. Windows now answers with its own tools instead:
 *
 *   netstat -ano   which PID holds a listening port
 *   tasklist       whether a PID exists, and its image name
 *   taskkill       terminate a process tree
 *
 * All three ship with Windows itself, so this needs no extra dependency and no
 * Git Bash, WSL or Cygwin.
 */

import { execFileSync } from "child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Run the first candidate that exists.
 *
 * Absolute paths first, because a minimal PATH (a service, a cron job, a
 * scrubbed environment) contains neither /usr/sbin nor System32 — and relying
 * on PATH is what made identity verification fail exactly where it mattered.
 *
 * @returns {string|null} output, "" if the tool ran but reported nothing,
 *                        null if no candidate exists at all
 */
function runFirst(candidates, args) {
  for (const bin of candidates) {
    try {
      return execFileSync(bin, args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        windowsHide: true,
      });
    } catch (err) {
      // ENOENT means "not at this path" — keep looking. Anything else means the
      // tool ran and failed, which is itself an answer.
      if (err.code !== "ENOENT") return "";
    }
  }
  return null;
}

const SYSTEM32 = `${process.env.SystemRoot || "C:\\\\Windows"}\\\\System32`;

const TOOLS = IS_WINDOWS
  ? {
      netstat: [`${SYSTEM32}\\\\netstat.exe`, "netstat"],
      tasklist: [`${SYSTEM32}\\\\tasklist.exe`, "tasklist"],
      taskkill: [`${SYSTEM32}\\\\taskkill.exe`, "taskkill"],
    }
  : {
      lsof: ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"],
      ps: ["/bin/ps", "/usr/bin/ps", "ps"],
    };

/**
 * Which PIDs hold `port` in LISTEN state.
 * @returns {number[]|null} null when the platform's tool is unavailable
 */
export function pidsListeningOn(port) {
  if (IS_WINDOWS) {
    // netstat -ano prints:  TCP  127.0.0.1:4173  0.0.0.0:0  LISTENING  1234
    const out = runFirst(TOOLS.netstat, ["-ano", "-p", "TCP"]);
    if (out === null) return null;
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      // Match the port exactly — ":4173" must not also match ":41730".
      if (!new RegExp(`:${port}$`).test(local)) continue;
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }

  const out = runFirst(TOOLS.lsof, ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
  if (out === null) return null;
  return out.split("\n").map((l) => Number(l.trim())).filter(Boolean);
}

/**
 * The command line (POSIX) or image name (Windows) of a PID.
 * @returns {string|null} null when the platform's tool is unavailable
 */
export function commandOf(pid) {
  if (IS_WINDOWS) {
    // CSV so the image name is quoted and parseable without guessing columns.
    const out = runFirst(TOOLS.tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    if (out === null) return null;
    const match = out.match(/^"([^"]+)"/m);
    return match ? match[1] : "";
  }

  const out = runFirst(TOOLS.ps, ["-p", String(pid), "-o", "command="]);
  return out === null ? null : out;
}

/**
 * Terminate a process and its children.
 *
 * Windows has no signals. `process.kill(pid, "SIGTERM")` there is an immediate,
 * ungraceful termination of that one process, which orphans anything it spawned
 * — a Next.js server's workers, for instance. taskkill /T walks the tree.
 *
 * @param {boolean} force  Windows: /F. POSIX: SIGKILL rather than SIGTERM.
 */
export function terminate(pid, { force = false } = {}) {
  if (IS_WINDOWS) {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const out = runFirst(TOOLS.taskkill, args);
    return out !== null;
  }

  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch (err) {
    return err.code === "ESRCH";   // already gone counts as terminated
  }
}

/** Can this platform inspect processes at all? Reported, never assumed. */
export function inspectionAvailable() {
  const probe = IS_WINDOWS
    ? runFirst(TOOLS.tasklist, ["/FI", "PID eq 0", "/FO", "CSV", "/NH"])
    : runFirst(TOOLS.ps, ["-p", String(process.pid), "-o", "pid="]);
  return probe !== null;
}

export const platformName = IS_WINDOWS ? "windows" : process.platform;
