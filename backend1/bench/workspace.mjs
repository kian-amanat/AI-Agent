/**
 * bench/workspace.mjs
 * Isolated per-benchmark workspaces, and the before/after snapshot that makes
 * "what actually changed on disk" a fact rather than something the agent tells us.
 *
 * The changed-file list here is deliberately independent of the agent's own
 * `editedFiles`. If the two disagree, that disagreement is itself a signal
 * worth scoring — so both are recorded and neither is trusted as the other.
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { slugifyId } from "./paths.mjs";

/** Never copied into a fixture, never snapshotted. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".bench-runs", "dist", "build", ".next",
  ".cache", "coverage", ".turbo", "__pycache__", ".venv",
]);

/**
 * Paths that are agent scratch space rather than task output. Kodo writes
 * throwaway probe scripts into `.kodo/scratch/` while working (and the repo's
 * own .gitignore already treats that directory as non-content). Counting them
 * as changed files made every "changed only what it needed to" check
 * permanently red — noise that trains people to ignore the report. They are
 * excluded from the diff, not from the workspace: a validator that cares can
 * still look, and nothing an agent leaves there can satisfy a real check.
 */
const IGNORED_PREFIXES = [".kodo/scratch/"];

const isIgnoredPath = (rel) => IGNORED_PREFIXES.some((p) => rel.startsWith(p));

const MAX_SNAPSHOT_FILES = 5000;

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (IGNORED_DIRS.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(s, d);
    else if (ent.isSymbolicLink()) await fs.symlink(await fs.readlink(s), d).catch(() => {});
    else if (ent.isFile()) await fs.copyFile(s, d);
  }
}

/**
 * Create a fresh, isolated workspace for one benchmark and seed it with the
 * benchmark's fixture tree (if any). Nothing is shared between benchmarks and
 * nothing is shared between reruns — that isolation is what makes reruns
 * comparable at all.
 */
export async function createWorkspace(benchmark, { parentDir } = {}) {
  const base = parentDir ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, `kodo-bench-${slugifyId(benchmark.id)}-`));
  if (benchmark.fixtureDir) await copyDir(benchmark.fixtureDir, dir);

  // Applied after the copy because git cannot carry arbitrary modes — a
  // benchmark that needs a genuinely unwritable file declares it in metadata.
  for (const [rel, mode] of Object.entries(benchmark.metadata?.fixtureModes ?? {})) {
    await fs.chmod(path.join(dir, rel), parseInt(String(mode), 8));
  }
  return dir;
}

export async function destroyWorkspace(dir) {
  if (!dir) return;
  // Read-only fixtures would otherwise survive cleanup and leak temp dirs.
  await fs.chmod(dir, 0o755).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function hash(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * Content-hash every file in the tree. Returns a plain object keyed by
 * POSIX-style relative path so snapshots serialise identically on any platform.
 */
export async function snapshotWorkspace(dir) {
  const out = {};
  let count = 0;

  async function walk(current, rel) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED_DIRS.has(ent.name)) continue;
      const abs = path.join(current, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(abs, relPath);
      } else if (ent.isFile()) {
        if (isIgnoredPath(relPath)) continue;
        if (count >= MAX_SNAPSHOT_FILES) return;
        count++;
        try {
          const buf = await fs.readFile(abs);
          out[relPath] = { hash: hash(buf), size: buf.length };
        } catch {
          /* unreadable file — absent from the snapshot, which reads as deleted/never-there */
        }
      }
    }
  }

  await walk(dir, "");
  // Rebuild sorted so the serialised JSON is byte-stable across runs.
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * The source of truth for "what did this run change". Sorted, so two runs of
 * the same benchmark produce comparable output.
 */
export function diffSnapshots(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [p, meta] of Object.entries(after)) {
    if (!(p in before)) added.push(p);
    else if (before[p].hash !== meta.hash) modified.push(p);
  }
  for (const p of Object.keys(before)) {
    if (!(p in after)) deleted.push(p);
  }
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted, changed: [...added, ...modified, ...deleted].sort() };
}
