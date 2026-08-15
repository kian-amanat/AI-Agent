/**
 * services/worktreePatch.mjs
 *
 * Diff → review → apply for worktree-isolated subagents.
 *
 * Without this, isolation means "discard": an isolated write-capable subagent
 * does real work that is thrown away with its worktree. This module extracts
 * the work as a real git patch BEFORE cleanup, holds it for review, and applies
 * it to the parent workspace only on explicit approval.
 *
 *   subagent edits worktree → extract diff → summarise → parent reviews
 *   → apply | reject → worktree removed either way
 *
 * SAFETY — apply is the only thing here that writes to the parent workspace:
 *   • every path in the patch is validated BEFORE anything is written,
 *   • paths escaping the workspace (absolute, .., symlink-ish) are refused,
 *   • protected paths (.git, .env, secrets, .kodo/settings.json) are refused,
 *   • `git apply --check` gates the real apply, so a patch that cannot apply
 *     cleanly never half-writes,
 *   • a failed apply is rolled back via `git apply -R`.
 * A rejected or failed patch leaves the parent workspace byte-identical.
 */

import crypto from "crypto";
import path from "path";
import { promises as fs } from "fs";
import { shellQuote } from "../core/runtime/host.mjs";

const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 400_000;
const MAX_TRACKED_PATCHES = 50;

// Never applicable from a subagent patch, no matter who approves it. These are
// the paths that would let a patch alter Kodo's own trust boundaries.
const PROTECTED_PATH_RE = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.kodo\/settings\.json$/,
  /(^|\/)\.kodo\/credentials\.json$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)id_(rsa|ed25519)(\.|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)node_modules(\/|$)/,
];

const patches = new Map(); // patchId → record

// The host `git()` helper that used to live here is gone.
//
// Every git invocation in this module now runs through the caller's
// ExecutionRuntime (see extractWorktreeDiff and applyPatch). Leaving the old
// helper behind as dead code would be a loaded gun: the next person needing
// "just a quick git call" would find a working host-side one sitting right
// there, and reintroduce the escape this module was fixed for.

/**
 * Extract everything the subagent changed in its worktree as one patch —
 * tracked modifications AND new files (added to the index first so they appear
 * in the diff; the index is local to the worktree and discarded with it).
 */
/**
 * Read a sub-agent's worktree as a patch.
 *
 * Takes a RUNTIME, not just a path. Under a sandbox the worktree lives inside
 * the container, so a host `git` invocation would be pointed at a path that
 * does not exist on the host — and before worktrees moved into the sandbox it
 * was worse: host git ran against a host checkout that the sandboxed agent had
 * never touched. Running git wherever the worktree actually is makes the two
 * agree by construction.
 */
export async function extractWorktreeDiff(runtime, worktreePath) {
  if (!runtime?.exec) throw new TypeError("extractWorktreeDiff requires an ExecutionRuntime");
  const gitIn = async (args) => {
    const res = await runtime.exec(
      `cd ${shellQuote(worktreePath)} && git ${args.map(shellQuote).join(" ")}`,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    return { ok: res.exit_code === 0, stdout: res.stdout || "", stderr: res.stderr || "" };
  };

  // `git add -A` here stages inside the WORKTREE only. It never touches the
  // parent's index — separate worktrees have separate indexes.
  const add = await gitIn(["add", "-A"]);
  if (!add.ok) return { ok: false, error: `could not stage worktree changes: ${add.stderr.slice(0, 200)}` };

  const diff = await gitIn(["diff", "--cached", "--binary", "--no-color"]);
  if (!diff.ok) return { ok: false, error: `git diff failed: ${diff.stderr.slice(0, 200)}` };

  const patch = diff.stdout;
  if (!patch.trim()) return { ok: true, empty: true, patch: "", files: [] };
  if (patch.length > MAX_DIFF_CHARS) {
    return { ok: false, error: `diff is too large to review safely (${patch.length} chars, limit ${MAX_DIFF_CHARS})` };
  }

  const stat = await gitIn(["diff", "--cached", "--numstat"]);
  const files = stat.stdout.split("\n").filter(Boolean).map((line) => {
    const [added, removed, file] = line.split("\t");
    return {
      path: file,
      added: added === "-" ? null : Number(added),   // "-" means binary
      removed: removed === "-" ? null : Number(removed),
      binary: added === "-",
    };
  }).filter((f) => f.path);

  return { ok: true, empty: false, patch, files };
}

/** Is this path safe to write in the parent workspace? */
export function validatePatchPath(relPath, workspaceRoot) {
  const p = String(relPath || "").trim();
  if (!p) return { ok: false, why: "empty path" };
  if (path.isAbsolute(p)) return { ok: false, why: "absolute paths are not applicable" };
  if (p.split(/[\\/]/).includes("..")) return { ok: false, why: "path traversal" };
  for (const re of PROTECTED_PATH_RE) {
    if (re.test(p)) return { ok: false, why: "protected path" };
  }
  // Belt and braces: the resolved target must still be inside the workspace.
  const resolved = path.resolve(workspaceRoot, p);
  if (!resolved.startsWith(path.resolve(workspaceRoot) + path.sep)) {
    return { ok: false, why: "resolves outside the workspace" };
  }
  return { ok: true };
}

/**
 * Structured summary for the parent to review. Deliberately does NOT include
 * the raw patch — the caller asks for that separately, so a summary can be put
 * in front of a model without dumping a huge diff into context.
 */
export function summarizeDiff({ files, patch }, workspaceRoot) {
  const added = files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed || 0), 0);

  const blocked = [];
  for (const f of files) {
    const v = validatePatchPath(f.path, workspaceRoot);
    if (!v.ok) blocked.push({ path: f.path, why: v.why });
  }

  // Cheap, honest signals — no semantic claims the diff doesn't support.
  const risky = [];
  for (const f of files) {
    if (/(^|\/)(package|package-lock|pnpm-lock|yarn\.lock)\.?/.test(f.path)) risky.push({ path: f.path, why: "dependency manifest" });
    if (/\.(yml|yaml|toml|conf|config\.[jt]s)$/.test(f.path)) risky.push({ path: f.path, why: "configuration" });
    if (/(migration|schema)/i.test(f.path)) risky.push({ path: f.path, why: "schema/migration" });
    if (f.binary) risky.push({ path: f.path, why: "binary file" });
    if ((f.added || 0) + (f.removed || 0) > 300) risky.push({ path: f.path, why: "very large change" });
  }

  return {
    fileCount: files.length,
    linesAdded: added,
    linesRemoved: removed,
    files: files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, binary: f.binary })),
    risky,
    blocked,
    applicable: blocked.length === 0,
    patchChars: patch.length,
  };
}

/**
 * Store a patch for review. Called BEFORE the worktree is removed, so the work
 * survives cleanup.
 */
export function storePatch({ subagentId, agentType, sessionId, requestId, workspaceRoot, diff, summary, testsRun = false, worktreeClean = true }) {
  const patchId = `patch_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  if (patches.size >= MAX_TRACKED_PATCHES) {
    const oldest = [...patches.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) patches.delete(oldest.patchId);
  }
  patches.set(patchId, {
    patchId, subagentId, agentType, sessionId, requestId, workspaceRoot,
    patch: diff.patch, summary, status: "pending",
    testsRun, worktreeClean,
    createdAt: Date.now(), decidedAt: null, decision: null, applyResult: null,
  });
  return patchId;
}

export function getPatch(patchId) {
  const p = patches.get(patchId);
  if (!p) return null;
  const { patch, ...rest } = p;   // raw diff only on explicit request
  return { ...rest, patchChars: patch.length };
}

export function getPatchDiff(patchId) {
  return patches.get(patchId)?.patch ?? null;
}

export function listPatches(sessionId = null) {
  return [...patches.values()]
    .filter((p) => !sessionId || p.sessionId === sessionId)
    .map((p) => getPatch(p.patchId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Apply a stored patch to the parent workspace.
 *
 * Gated by `git apply --check` so a patch that cannot apply cleanly never
 * writes anything; a real apply that still fails is reversed with `git apply -R`
 * so the workspace is left as it was.
 */
/**
 * Apply a reviewed patch to the workspace, THROUGH the runtime.
 *
 * This wrote a temp diff with host `fs` and ran host `git apply` against the
 * host workspace. Under `--sandbox docker` that mutated the real host files
 * while the agent believed every write was confined — the single most direct
 * escape in the tool surface, because the agent explicitly asks for it.
 */
export async function applyPatch(patchId, { workspaceRoot, runtime } = {}) {
  if (!runtime?.exec) throw new TypeError("applyPatch requires an ExecutionRuntime");
  const record = patches.get(patchId);
  if (!record) return { ok: false, error: `Unknown patch "${patchId}".` };
  if (record.status !== "pending") {
    return { ok: false, error: `Patch "${patchId}" was already ${record.status}.` };
  }

  const root = workspaceRoot || record.workspaceRoot;

  // Re-validate at APPLY time, not just at summary time — the workspace or
  // rules may have changed since the review.
  const blocked = record.summary.files
    .map((f) => ({ path: f.path, v: validatePatchPath(f.path, root) }))
    .filter((x) => !x.v.ok);
  if (blocked.length) {
    record.status = "blocked";
    record.decidedAt = Date.now();
    return {
      ok: false, blocked: true,
      error: `Refusing to apply — forbidden paths: ${blocked.map((b) => `${b.path} (${b.v.why})`).join(", ")}`,
    };
  }

  // Workspace-relative: it must land wherever the runtime's workspace is.
  const tmpRel = `.kodo-patch-${patchId}.diff`;
  const gitApply = async (extra) => {
    const res = await runtime.exec(
      `git apply ${extra} --whitespace=nowarn ${shellQuote(tmpRel)}`,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    return { ok: res.exit_code === 0, stdout: res.stdout || "", stderr: res.stderr || "" };
  };

  try {
    await runtime.writeFile(tmpRel, record.patch);

    const check = await gitApply("--check");
    if (!check.ok) {
      record.status = "failed";
      record.decidedAt = Date.now();
      record.applyResult = { ok: false, stage: "check", detail: check.stderr.slice(0, 400) };
      return { ok: false, error: `Patch does not apply cleanly to the workspace: ${check.stderr.slice(0, 300)}`, applied: false };
    }

    const applied = await gitApply("");
    if (!applied.ok) {
      // Should be unreachable after --check, but reverse anything partial.
      await gitApply("-R");
      record.status = "failed";
      record.decidedAt = Date.now();
      record.applyResult = { ok: false, stage: "apply", detail: applied.stderr.slice(0, 400) };
      return { ok: false, error: `Apply failed and was rolled back: ${applied.stderr.slice(0, 300)}`, applied: false };
    }

    record.status = "applied";
    record.decision = "approve";
    record.decidedAt = Date.now();
    record.applyResult = { ok: true, files: record.summary.files.map((f) => f.path) };
    return { ok: true, applied: true, files: record.summary.files.map((f) => f.path) };
  } catch (err) {
    record.status = "failed";
    record.applyResult = { ok: false, stage: "io", detail: String(err?.message || err) };
    return { ok: false, error: `Apply failed: ${String(err?.message || err)}`, applied: false };
  } finally {
    // Through the runtime too — the temp diff was written inside the sandbox.
    await runtime.deleteFile(tmpRel).catch(() => {});
  }
}

/** Discard a patch. The parent workspace is untouched by definition. */
export function rejectPatch(patchId, reason = "") {
  const record = patches.get(patchId);
  if (!record) return { ok: false, error: `Unknown patch "${patchId}".` };
  if (record.status !== "pending") return { ok: false, error: `Patch "${patchId}" was already ${record.status}.` };
  record.status = "rejected";
  record.decision = "reject";
  record.decidedAt = Date.now();
  record.applyResult = { ok: true, discarded: true, reason: String(reason || "") };
  return { ok: true, rejected: true };
}

export function _resetPatches() { patches.clear(); }
export function patchCount() { return patches.size; }
