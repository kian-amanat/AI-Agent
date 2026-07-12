import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import db from "../db.mjs";

const execAsync = promisify(exec);

function getWorkspacePath(request) {
  try {
    const auth = request.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) return null;
    const token = auth.slice(7).trim();
    const session = db
      .prepare("SELECT workspace_path FROM auth_sessions WHERE token = ?")
      .get(token);
    return session?.workspace_path || null;
  } catch {
    return null;
  }
}

const IGNORE = new Set([
  ".git", "node_modules", ".next", "dist", "build", ".cache",
  "__pycache__", ".agent-history", "coverage", ".turbo", ".svelte-kit",
  "out", ".output", ".nuxt",
]);

export default async function workspaceRoute(fastify) {
  // GET /api/workspace/git — current branch + dirty/ahead status
  fastify.get("/git", async (request) => {
    const root = getWorkspacePath(request) || process.cwd();

    const [branch, statusOut, aheadOut] = await Promise.all([
      execAsync("git rev-parse --abbrev-ref HEAD", { cwd: root, timeout: 3000 })
        .then((r) => r.stdout.trim())
        .catch(() => "unknown"),
      execAsync("git status --porcelain", { cwd: root, timeout: 3000 })
        .then((r) => r.stdout.trim())
        .catch(() => ""),
      execAsync("git rev-list --count @{u}..HEAD 2>/dev/null", { cwd: root, timeout: 3000 })
        .then((r) => parseInt(r.stdout.trim(), 10) || 0)
        .catch(() => 0),
    ]);

    return { ok: true, branch, dirty: statusOut.length > 0, ahead: aheadOut };
  });

  // GET /api/workspace/files — workspace file tree
  fastify.get("/files", async (request) => {
    const root = getWorkspacePath(request) || process.cwd();
    const MAX_DEPTH = 6;
    const MAX_FILES = 800;
    const files = [];

    async function walk(dir, depth = 0) {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      // dirs first, then files, alphabetical within each group
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory())
          return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;
        if (files.length >= MAX_FILES) break;

        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          files.push({ path: rel, type: "dir" });
          await walk(abs, depth + 1);
        } else {
          files.push({ path: rel, type: "file" });
        }
      }
    }

    await walk(root);
    return { ok: true, files, root };
  });
}
