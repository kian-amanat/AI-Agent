/**
 * core/runtime/contract.mjs — the execution boundary.
 *
 * Every operation an agent tool performs that can read the workspace, change
 * the workspace, or execute code goes through an ExecutionRuntime. That is the
 * whole invariant:
 *
 *     Agent → Tools → ExecutionRuntime → { Host | Docker | Incus }
 *
 * A tool that reaches for `fs` or `spawn` directly is a hole in the sandbox,
 * and it does not matter how small: a DockerRuntime that isolates `bash` while
 * `write_file` still writes to the host is not a sandbox, it is a sandbox-shaped
 * label on host access. `tests/runtimeBoundary.test.mjs` fails the build if one
 * reappears.
 *
 * ── What is inside the boundary ──────────────────────────────────────────────
 *
 * Workspace content and code execution:
 *   stat · readFile · writeFile · deleteFile · walk · grep
 *   exec · execBackground · readBackgroundOutput · killBackground
 *
 * ── What is deliberately outside it ──────────────────────────────────────────
 *
 *   1. Undo snapshots (~/.agent-history). Kodo's control plane. If the undo
 *      history lived inside the sandbox, tearing the sandbox down would destroy
 *      the user's ability to revert — inverting the safety property it exists
 *      for. Snapshots read the file THROUGH the runtime and write the copy to
 *      the host.
 *   2. Settings bootstrap (.kodo/settings.json). Permissions govern what a
 *      runtime may do, so they must be known before one is constructed.
 *   3. Session/memory/database state. Not workspace content.
 *
 * Stating this precisely is the point. "Sandboxed" is only meaningful if you
 * can say what is inside.
 *
 * ── Path convention ──────────────────────────────────────────────────────────
 *
 * Every path crossing this interface is WORKSPACE-RELATIVE and POSIX-separated.
 * Absolute host paths must never cross it: a container's view of the workspace
 * is rooted somewhere else entirely (/workspace), so passing host absolutes
 * would either leak the host layout into the container or silently miss.
 * Confinement (`safeResolve`) happens above the interface; each runtime maps a
 * relative path onto its own root below it.
 */

/**
 * @typedef {object} ExecResult
 * @property {number|null} exit_code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} [timed_out]
 */

/**
 * @typedef {object} StatResult
 * @property {boolean} isFile
 * @property {boolean} isDirectory
 * @property {number} size
 */

/**
 * @typedef {object} WalkEntry
 * @property {string} path   workspace-relative, POSIX separators
 * @property {boolean} isDir
 */

/**
 * The contract every runtime implements.
 *
 * Methods take workspace-relative paths and return plain data — no fs.Stats, no
 * ChildProcess. Anything richer would leak host types through the boundary and
 * make a container implementation impossible to write honestly.
 *
 * @typedef {object} ExecutionRuntime
 * @property {string}   name              "host" | "docker" | "incus"
 * @property {boolean}  isolated          false for host; true only when the
 *                                        implementation genuinely confines
 *                                        file AND process operations.
 * @property {() => Promise<void>}        start
 * @property {() => Promise<void>}        cleanup
 * @property {() => Promise<IsolationReport>} verifyIsolation
 * @property {(rel: string) => Promise<StatResult|null>} stat
 * @property {(rel: string, maxBytes?: number) => Promise<string|null>} readFile
 * @property {(rel: string, content: string) => Promise<void>} writeFile
 * @property {(rel: string) => Promise<boolean>} deleteFile
 * @property {(rel: string, maxDepth?: number) => Promise<WalkEntry[]>} walk
 * @property {(pattern: string, glob: string|null) => Promise<{matches: string[], count: number}>} grep
 * @property {(command: string, opts?: {cwd?: string, timeoutMs?: number}) => Promise<ExecResult>} exec
 * @property {(command: string) => Promise<{id: string, outputFile: string}>} execBackground
 * @property {(id: string) => Promise<object>} readBackgroundOutput
 * @property {(id: string) => object} killBackground
 * @property {(root: string) => ExecutionRuntime} derive  a runtime for a
 *           different root (git-worktree sub-agent isolation). A confined
 *           runtime MUST refuse a root it cannot actually reach rather than
 *           returning something that quietly executes on the host.
 * @property {() => string} worktreeRoot  where this runtime puts worktrees.
 *           On the host, a temp directory. In a container, a path INSIDE it.
 * @property {(opts: {subagentId, sessionId?, ref?}) => Promise<WorktreeResult>} createWorktree
 * @property {(id: string) => Promise<{ok: boolean, removed: boolean}>} removeWorktree
 */

/**
 * Git worktrees are part of the execution boundary, not a detail beside it.
 *
 * A sub-agent with `isolation: worktree` gets a real git checkout to work in.
 * If that checkout is created on the HOST while the agent executes in a
 * container, three things are true at once and all of them are bad: the
 * sandboxed run has written to the host filesystem outside the workspace, the
 * agent cannot see the checkout it was given, and Kodo has quietly done the one
 * thing `--sandbox` promised it would not.
 *
 * So worktree creation belongs to the runtime. Each implementation puts the
 * checkout somewhere it can actually reach, and `derive()` then re-roots onto
 * it without anything crossing the boundary.
 *
 * @typedef {object} WorktreeResult
 * @property {boolean} ok
 * @property {string} [error]
 * @property {{worktreeId: string, path: string, repoRoot: string, ref: string}} [worktree]
 */

/**
 * @typedef {object} IsolationReport
 * @property {boolean} isolated  did this runtime PROVE confinement, right now
 * @property {string[]} checks   human-readable results, in order
 * @property {string} [reason]   why it failed, when it did
 */

/** Methods a runtime must implement to be accepted by the agent. */
export const RUNTIME_METHODS = Object.freeze([
  "start",
  "derive",
  "createWorktree",
  "removeWorktree",
  "worktreeRoot",
  "cleanup",
  "verifyIsolation",
  "stat",
  "readFile",
  "writeFile",
  "deleteFile",
  "walk",
  "grep",
  "exec",
  "execBackground",
  "readBackgroundOutput",
  "killBackground",
]);

/**
 * Structural check, run when a runtime is installed into a run.
 *
 * A runtime missing `writeFile` would otherwise surface as a TypeError deep in
 * a tool call, halfway through a task, with the workspace half-edited.
 */
export function assertRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("ExecutionRuntime: expected an object");
  }
  const missing = RUNTIME_METHODS.filter((m) => typeof runtime[m] !== "function");
  if (missing.length) {
    throw new Error(
      `ExecutionRuntime "${runtime.name || "unnamed"}" is missing: ${missing.join(", ")}. ` +
      "Every runtime must implement the full contract — a partial one means some tool " +
      "silently escapes the boundary.",
    );
  }
  if (typeof runtime.name !== "string" || !runtime.name) {
    throw new Error("ExecutionRuntime: name is required");
  }
  return runtime;
}

/** Normalise any incoming path to the relative POSIX form the contract requires. */
export function toRelativePosix(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}
