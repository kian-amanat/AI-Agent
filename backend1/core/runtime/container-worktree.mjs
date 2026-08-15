/**
 * core/runtime/container-worktree.mjs — worktrees inside a container.
 *
 * Shared by DockerRuntime and IncusRuntime because the logic is identical once
 * you have "run a shell command in the sandbox": the difference between them is
 * the transport, not the git.
 *
 * Why this exists at all: a sub-agent with `isolation: worktree` gets a real
 * git checkout to work in. Creating that checkout on the HOST while the agent
 * executes in a container is a sandbox escape — the run writes to the host
 * filesystem outside the workspace, and the agent cannot see the directory it
 * was just handed. So the checkout is created *in the sandbox*, under a fixed
 * path the runtime can reach.
 *
 * The workspace is the git repository, and it is present inside the container
 * (bind-mounted or copied in), so `git worktree add` run inside the container
 * produces a checkout the container can use and the host never sees.
 *
 * Constraints this places on the sandbox image, checked and reported rather
 * than assumed:
 *   - git must be installed inside the container;
 *   - the workspace must actually be a git repository.
 * Both fail with a clear message instead of a confusing git error.
 */

import crypto from "crypto";
import { shellQuote } from "./host.mjs";

/** Fixed, inside-the-container location. Never a host path. */
export const CONTAINER_WORKTREE_ROOT = "/kodo-worktrees";

/**
 * @param {object} runtime  a started runtime exposing exec()/workdir
 * @param {{subagentId, sessionId?, ref?}} options
 */
export async function createContainerWorktree(runtime, { subagentId, sessionId = null, ref = "HEAD" }) {
  const label = runtime.name === "docker" ? "container" : "instance";

  // git present?
  const haveGit = await runtime.exec("command -v git >/dev/null 2>&1 && echo yes || echo no", { timeoutMs: 15_000 });
  if (!haveGit.stdout.includes("yes")) {
    return {
      ok: false,
      error:
        `isolation: worktree needs git inside the sandbox ${label}, and the image ` +
        `"${runtime.image}" does not have it. Use an image that includes git ` +
        "(the default node image does), or run the sub-agent without worktree isolation.",
    };
  }

  // A git repository?
  const isRepo = await runtime.exec("git rev-parse --show-toplevel 2>/dev/null || true", { timeoutMs: 15_000 });
  const repoRoot = isRepo.stdout.trim();
  if (!repoRoot) {
    return {
      ok: false,
      error: `isolation: worktree requires a git repository, but the workspace mounted into the sandbox ${label} is not one.`,
    };
  }

  const worktreeId = `wt_${String(subagentId || "sub").replace(/[^A-Za-z0-9_-]/g, "")}_${crypto.randomBytes(4).toString("hex")}`;
  const worktreePath = `${CONTAINER_WORKTREE_ROOT}/${worktreeId}`;

  // Detached HEAD on purpose: the sub-agent must not move, or be blocked by,
  // whatever branch the user has checked out.
  const add = await runtime.exec(
    `mkdir -p ${shellQuote(CONTAINER_WORKTREE_ROOT)} && ` +
    `git worktree add --detach ${shellQuote(worktreePath)} ${shellQuote(ref)} 2>&1`,
    { timeoutMs: 120_000 },
  );
  if (add.exit_code !== 0) {
    return { ok: false, error: `git worktree add failed inside the sandbox: ${String(add.stdout || add.stderr).slice(0, 300)}` };
  }

  return {
    ok: true,
    worktree: {
      worktreeId,
      path: worktreePath,      // a CONTAINER path — never valid on the host
      repoRoot,
      ref,
      subagentId: subagentId ?? null,
      sessionId,
      createdAt: Date.now(),
      status: "active",
      inSandbox: true,
    },
  };
}

/**
 * Remove a worktree from inside the container.
 *
 * Refuses anything outside the controlled prefix, exactly as the host manager
 * does — the alternative is running `rm -rf` on an attacker-influenced path
 * inside a container that has the workspace mounted.
 */
export async function removeContainerWorktree(runtime, registry, worktreeId) {
  const record = registry.get(worktreeId);
  if (!record) return { ok: true, removed: false, reason: "unknown or already removed" };
  if (record.status === "removed") return { ok: true, removed: false, reason: "already removed" };

  if (!record.path.startsWith(`${CONTAINER_WORKTREE_ROOT}/`)) {
    record.status = "refused";
    return { ok: false, removed: false, error: `refusing to remove "${record.path}" — outside the controlled worktree root` };
  }

  // `git worktree remove` first so git's own metadata is cleaned up; the rm is
  // the backstop for a worktree git has already lost track of.
  const res = await runtime.exec(
    `git worktree remove --force ${shellQuote(record.path)} 2>/dev/null; rm -rf ${shellQuote(record.path)}; ` +
    "git worktree prune 2>/dev/null; true",
    { timeoutMs: 60_000 },
  );
  record.status = "removed";
  return { ok: res.exit_code === 0, removed: true };
}
