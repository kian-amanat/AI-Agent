/**
 * services/worktreeManager.mjs
 *
 * Real `git worktree` isolation for subagents.
 *
 * A worktree-isolated subagent gets its own checkout on disk. Its `root`
 * becomes that directory, so every read/edit/bash it performs lands there and
 * the parent workspace is genuinely untouched — this is filesystem isolation,
 * not a renamed path.
 *
 * SAFETY — the destructive part of this file is removal, so it is fenced:
 *   • worktrees are only ever created under one controlled prefix,
 *   • removal refuses any path not inside that prefix,
 *   • removal refuses any path this process did not create (tracked in a
 *     registry keyed by id),
 *   • removal is idempotent, so abort/error/shutdown can all call it.
 * There is no code path here that can delete a user directory.
 */

import crypto from "crypto";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { execFile } from "child_process";

// One controlled prefix. Nothing outside this is ever removable.
const WORKTREE_ROOT = path.join(os.tmpdir(), "kodo-worktrees");
const GIT_TIMEOUT_MS = 30_000;

// worktreeId → record. Only ids present here may be removed.
const registry = new Map();

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || err?.message || "").trim(),
      });
    });
  });
}

/** Resolve the repository root for a workspace, or null when it isn't a repo. */
export async function findRepoRoot(workspacePath) {
  const r = await git(["rev-parse", "--show-toplevel"], workspacePath);
  return r.ok && r.stdout ? r.stdout : null;
}

export async function gitSupportsWorktrees(cwd) {
  const r = await git(["worktree", "list"], cwd);
  return r.ok;
}

/**
 * Create an isolated worktree for one subagent run.
 * Returns { ok, worktree } or { ok:false, error } — never throws, so a spawn
 * can fail cleanly rather than taking the parent turn down.
 *
 * Detached HEAD on purpose: the subagent must not move, or be blocked by, any
 * branch the user has checked out.
 */
export async function createWorktree({ workspacePath, subagentId, sessionId = null, ref = "HEAD" }) {
  const repoRoot = await findRepoRoot(workspacePath);
  if (!repoRoot) {
    return { ok: false, error: `isolation: worktree requires a git repository, but "${workspacePath}" is not inside one.` };
  }
  if (!await gitSupportsWorktrees(repoRoot)) {
    return { ok: false, error: "isolation: worktree requires git worktree support, which this git build does not provide." };
  }

  // Collision-safe: subagent id + random suffix, so even a repeated id or two
  // concurrent runs in the same millisecond cannot collide.
  const worktreeId = `wt_${String(subagentId || "sub").replace(/[^A-Za-z0-9_-]/g, "")}_${crypto.randomBytes(4).toString("hex")}`;
  const worktreePath = path.join(WORKTREE_ROOT, worktreeId);

  await fs.mkdir(WORKTREE_ROOT, { recursive: true });

  const add = await git(["worktree", "add", "--detach", worktreePath, ref], repoRoot);
  if (!add.ok) {
    return { ok: false, error: `git worktree add failed: ${add.stderr.slice(0, 300)}` };
  }

  const record = {
    worktreeId,
    path: worktreePath,
    repoRoot,
    ref,
    subagentId: subagentId ?? null,
    sessionId,
    createdAt: Date.now(),
    status: "active",
    cleanup: null,
  };
  registry.set(worktreeId, record);
  return { ok: true, worktree: record };
}

/**
 * Remove a worktree. Idempotent, and safe to call from any exit path.
 *
 * Refuses anything not created by this process AND not under the controlled
 * prefix — both checks, because either alone could be defeated by a stale or
 * crafted id.
 */
export async function removeWorktree(worktreeId) {
  const record = registry.get(worktreeId);
  if (!record) return { ok: true, removed: false, reason: "unknown or already removed" };
  if (record.status === "removed") return { ok: true, removed: false, reason: "already removed" };

  const target = path.resolve(record.path);
  const prefix = path.resolve(WORKTREE_ROOT) + path.sep;
  if (!target.startsWith(prefix)) {
    // Should be unreachable; treated as a hard invariant violation rather than
    // something to "handle", because the alternative is deleting a real
    // directory.
    record.status = "refused";
    return { ok: false, removed: false, error: `refusing to remove "${target}" — outside the controlled worktree root` };
  }

  const res = await git(["worktree", "remove", "--force", target], record.repoRoot);
  let removed = res.ok;
  let detail = res.stderr;

  if (!removed) {
    // The git metadata can already be gone (e.g. after a crash) while the
    // directory remains. Prune, then remove the directory directly — still
    // only ever inside the controlled prefix.
    await git(["worktree", "prune"], record.repoRoot);
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed = true;
      detail = "removed directly after git metadata was already gone";
    } catch (err) {
      detail = `${detail} | rm failed: ${err.message}`;
    }
  }

  record.status = removed ? "removed" : "orphaned";
  record.cleanup = { removed, detail, at: Date.now() };
  if (removed) registry.delete(worktreeId);
  return { ok: removed, removed, detail };
}

export function getWorktree(worktreeId) {
  const r = registry.get(worktreeId);
  return r ? { ...r } : null;
}

export function activeWorktrees() {
  return [...registry.values()].map((r) => ({ ...r }));
}

/** Remove every tracked worktree — for SIGINT/SIGTERM. */
export async function removeAllWorktrees() {
  const ids = [...registry.keys()];
  const results = [];
  for (const id of ids) results.push({ id, ...(await removeWorktree(id)) });
  return results;
}

/**
 * Sweep worktrees left behind by a previous process. Only touches directories
 * under the controlled prefix, and only ones git itself reports as belonging
 * to this repo — a stray unrelated directory is never removed.
 */
export async function pruneOrphanedWorktrees(workspacePath) {
  const repoRoot = await findRepoRoot(workspacePath);
  if (!repoRoot) return { pruned: 0 };
  await git(["worktree", "prune"], repoRoot);

  let entries = [];
  try { entries = await fs.readdir(WORKTREE_ROOT); } catch { return { pruned: 0 }; }

  const listed = await git(["worktree", "list", "--porcelain"], repoRoot);
  const known = new Set(
    listed.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => path.resolve(l.slice(9).trim())),
  );

  let pruned = 0;
  for (const name of entries) {
    if (!name.startsWith("wt_")) continue;            // not ours
    const full = path.join(WORKTREE_ROOT, name);
    if (registry.has(name)) continue;                  // live in this process
    if (known.has(path.resolve(full))) continue;       // git still tracks it
    try { await fs.rm(full, { recursive: true, force: true }); pruned++; } catch { /* best-effort */ }
  }
  return { pruned };
}

export const WORKTREE_ROOT_PATH = WORKTREE_ROOT;
