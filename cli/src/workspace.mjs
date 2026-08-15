/**
 * src/workspace.mjs — what "the project" means for a CLI invocation.
 *
 * The HTTP surface gets its workspace from the authenticated session and
 * REFUSES to run without one (routes/plannerAgent.mjs), because one server
 * process serves several accounts and a fallback there would let an
 * unconfigured user write files into whatever repo the server happened to be
 * launched from. The CLI has the opposite situation and must not copy that
 * rule: it runs as you, in a shell you chose, and `cd my-project && kodo` can
 * only sensibly mean this directory. So cwd IS the workspace here — explicitly,
 * and reported in the banner so it is never ambiguous which tree is about to be
 * edited.
 *
 * Git is detected, never required.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export function detectWorkspace(cwdOption = "") {
  const resolved = path.resolve(cwdOption || process.cwd());

  if (!fs.existsSync(resolved)) {
    return { path: resolved, exists: false, git: null };
  }

  const topLevel = git(["rev-parse", "--show-toplevel"], resolved);
  if (!topLevel) {
    return { path: resolved, exists: true, git: null };
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], resolved) || "(detached)";
  const status = git(["status", "--porcelain"], resolved);
  return {
    path: resolved,
    exists: true,
    git: {
      root: topLevel,
      branch,
      // `status` is "" for a clean tree and null only if the call failed.
      clean: status === "",
      dirtyFiles: status ? status.split("\n").filter(Boolean).length : 0,
    },
  };
}

/** `~/projects/app` — shorter and safer to show than an absolute home path. */
export function displayPath(absolute) {
  const home = os.homedir();
  return absolute.startsWith(home) ? `~${absolute.slice(home.length)}` : absolute;
}

export function describeWorkspace(ws) {
  const lines = [`Workspace: ${displayPath(ws.path)}`];
  if (ws.git) {
    lines.push(`Git: ${ws.git.clean ? "clean" : `${ws.git.dirtyFiles} uncommitted change(s)`}`);
    lines.push(`Branch: ${ws.git.branch}`);
  } else {
    lines.push("Git: not detected");
  }
  return lines;
}
