import { exec, execFile } from "child_process";
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

// Turn a git remote URL into "owner/repo" for GitHub — handles both
// https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git).
// Returns null for non-GitHub remotes (the PR link only works for GitHub).
function parseGitHubSlug(remoteUrl) {
  const url = String(remoteUrl || "").trim();
  const m =
    url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// The GitHub "open a pull request" page for the current branch against the
// repo's default branch — the same link `git push` prints for a new branch.
// Returns null when there's nothing to PR (on the default branch, non-GitHub
// remote, or no remote). The user clicks through and creates the PR on GitHub.
async function buildPullRequestUrl(root, branch) {
  try {
    const remoteUrl = (await execAsync("git remote get-url origin", { cwd: root, timeout: 3000 })).stdout.trim();
    const slug = parseGitHubSlug(remoteUrl);
    if (!slug) return null;

    // Default branch (main/master) the PR would merge into. Prefer the remote's
    // declared HEAD; if that isn't set locally, probe the usual names; finally
    // fall back to "main" (GitHub still lets the user change the base branch).
    let defaultBranch = await execAsync("git symbolic-ref --short refs/remotes/origin/HEAD", { cwd: root, timeout: 3000 })
      .then((r) => r.stdout.trim().replace(/^origin\//, ""))
      .catch(() => "");
    if (!defaultBranch) {
      for (const b of ["main", "master"]) {
        const exists = await execAsync(`git rev-parse --verify --quiet refs/remotes/origin/${b}`, { cwd: root, timeout: 3000 })
          .then(() => true)
          .catch(() => false);
        if (exists) { defaultBranch = b; break; }
      }
    }
    if (!defaultBranch) defaultBranch = "main";

    if (!branch || branch === "unknown" || branch === defaultBranch) return null;

    const enc = (s) => encodeURIComponent(s);
    return `https://github.com/${slug}/compare/${enc(defaultBranch)}...${enc(branch)}?expand=1`;
  } catch {
    return null;
  }
}

export default async function workspaceRoute(fastify) {
  // GET /api/workspace/git — current branch + dirty/ahead status
  fastify.get("/git", async (request) => {
    const root = getWorkspacePath(request) || process.cwd();

    const [branch, statusOut, hasUpstream, hasCommits] = await Promise.all([
      execAsync("git rev-parse --abbrev-ref HEAD", { cwd: root, timeout: 3000 })
        .then((r) => r.stdout.trim())
        .catch(() => "unknown"),
      execAsync("git status --porcelain", { cwd: root, timeout: 3000 })
        .then((r) => r.stdout.trim())
        .catch(() => ""),
      execAsync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { cwd: root, timeout: 3000 })
        .then(() => true)
        .catch(() => false),
      execAsync("git rev-parse --verify HEAD", { cwd: root, timeout: 3000 })
        .then(() => true)
        .catch(() => false),
    ]);

    // A brand-new local branch has no @{u} to diff against, so the usual
    // `rev-list @{u}..HEAD` ahead-count always resolves to 0 — which used to
    // hide the Push button on a branch's very first push. Once it has a
    // commit and no upstream, it always needs pushing regardless of count.
    const ahead = hasUpstream
      ? await execAsync("git rev-list --count @{u}..HEAD", { cwd: root, timeout: 3000 })
          .then((r) => parseInt(r.stdout.trim(), 10) || 0)
          .catch(() => 0)
      : hasCommits
        ? await execAsync("git rev-list --count HEAD", { cwd: root, timeout: 3000 })
            .then((r) => parseInt(r.stdout.trim(), 10) || 0)
            .catch(() => 1)
        : 0;

    // Only surface a PR link once the branch is actually on the remote —
    // GitHub's compare page needs the branch pushed, or it 404s.
    const pullRequestUrl = hasUpstream ? await buildPullRequestUrl(root, branch) : null;

    // Count of changed files (for the "N uncommitted" summary in the Git panel).
    const uncommittedCount = statusOut ? statusOut.split("\n").filter(Boolean).length : 0;

    return {
      ok: true, branch,
      dirty: statusOut.length > 0, uncommittedCount,
      ahead, hasUpstream, pullRequestUrl,
    };
  });

  // POST /api/workspace/git/commit — stage everything and commit
  fastify.post("/git/commit", async (request) => {
    const root = getWorkspacePath(request) || process.cwd();
    const message = String(request.body?.message || "").trim();
    if (!message) return { ok: false, error: "Commit message is required" };

    try {
      const { stdout: statusOut } = await execAsync("git status --porcelain", { cwd: root, timeout: 5000 });
      if (!statusOut.trim()) return { ok: false, error: "Nothing to commit — working tree is clean" };

      await execAsync("git add -A", { cwd: root, timeout: 15000 });
      // -F - reads the message from stdin so it can't be misparsed as flags
      // or break on quotes/newlines the way string interpolation would.
      await new Promise((resolve, reject) => {
        const child = execFile("git", ["commit", "-F", "-"], { cwd: root, timeout: 15000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr?.trim() || stdout?.trim() || err.message));
          else resolve(stdout);
        });
        child.stdin.write(message);
        child.stdin.end();
      });

      const { stdout: hashOut } = await execAsync("git rev-parse --short HEAD", { cwd: root, timeout: 3000 });
      return { ok: true, hash: hashOut.trim(), message };
    } catch (err) {
      return { ok: false, error: err.message || "Commit failed" };
    }
  });

  // POST /api/workspace/git/push — push the current branch, setting upstream
  // on first push if none is configured yet
  fastify.post("/git/push", async (request) => {
    const root = getWorkspacePath(request) || process.cwd();

    try {
      const branch = (await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: root, timeout: 3000 })).stdout.trim();
      const hasUpstream = await execAsync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { cwd: root, timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      const pushCmd = hasUpstream ? "git push" : `git push -u origin ${branch.replace(/[^a-zA-Z0-9_./-]/g, "")}`;
      const { stdout, stderr } = await execAsync(pushCmd, { cwd: root, timeout: 60000 });
      // After a successful push the branch is on the remote, so hand back the
      // GitHub "open a pull request" link for the user to click through.
      const pullRequestUrl = await buildPullRequestUrl(root, branch);
      return { ok: true, branch, output: (stdout + stderr).trim().slice(0, 2000), pullRequestUrl };
    } catch (err) {
      const message = (err.stderr || err.message || "Push failed").toString().trim();
      console.error(`[workspace] git push failed in ${root}:\n${message}`);
      return { ok: false, error: message.slice(0, 500) };
    }
  });

  // GET /api/workspace/git/branches — list all branches
  fastify.get("/git/branches", async (request) => {
    const root = getWorkspacePath(request) || process.cwd();

    const { stdout } = await execAsync("git branch --format='%(refname:short) %(HEAD)'", {
      cwd: root,
      timeout: 5000,
    }).catch(() => ({ stdout: "" }));

    const currentBranch = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      timeout: 3000,
    }).then((r) => r.stdout.trim()).catch(() => "unknown");

    const branches = stdout
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        // Format: "branch-name HEAD" for current, "branch-name" for others
        const parts = trimmed.split(/\s+/);
        const name = parts[0];
        const isHead = parts.includes("HEAD");
        return { name, current: isHead || name === currentBranch };
      })
      .filter(Boolean);

    return { ok: true, branches };
  });

  // POST /api/workspace/git/checkout — switch branch
  fastify.post("/git/checkout", async (request) => {
    const root = getWorkspacePath(request) || process.cwd();
    const body = request.body;
    const branch = body?.branch;

    if (!branch) {
      return fastify.httpErrors.badRequest("Missing branch name");
    }

    try {
      await execAsync(`git checkout ${branch.replace(/[^a-zA-Z0-9_./-]/g, "")}`, {
        cwd: root,
        timeout: 10000,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || "Failed to switch branch" };
    }
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

  // GET /api/workspace/roots — candidate projects for the root picker: a
  // flat list of SIBLING project folders (other directories next to the
  // current one, under the same parent — e.g. current = ~/Developer/ai-sandbox
  // lists ~/Developer/avand, ~/Developer/whatever-else), exactly the same
  // shape as GET /git/branches. No hierarchy, no separate browse step —
  // click a name, it switches, same as picking a branch.
  fastify.get("/roots", async (request) => {
    const root       = getWorkspacePath(request) || process.cwd();
    const siblingDir = path.dirname(root);

    let entries = [];
    try {
      entries = await fs.readdir(siblingDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const options = entries
      .filter((e) => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith("."))
      .map((e) => {
        const abs = path.join(siblingDir, e.name);
        return { path: abs, name: e.name, current: abs === root };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      ok: true,
      current: { path: root, name: path.basename(root) || root },
      options,
    };
  });
}
