/**
 * src/paths.mjs — where Kodo keeps its own state on disk.
 *
 * One home directory (`~/.kodo`, overridable with KODO_HOME) holds everything
 * the CLI owns: user configuration, server runtime state, logs and CLI session
 * transcripts. That single override is what makes the whole surface testable —
 * the test suite points KODO_HOME at a temp directory and can then exercise
 * real start/stop/stale-PID behaviour without touching the developer's own
 * running server.
 *
 * `~/.kodo` is also what `kodo update` must never destroy and what
 * `kodo uninstall` must ask before removing.
 */

import fs from "fs";
import os from "os";
import path from "path";

export function kodoHome() {
  return process.env.KODO_HOME || path.join(os.homedir(), ".kodo");
}

export const userConfigPath  = () => path.join(kodoHome(), "config.json");
export const runtimeDir      = () => path.join(kodoHome(), "runtime");
export const logsDir         = () => path.join(kodoHome(), "logs");
export const sessionsDir     = () => path.join(kodoHome(), "sessions");

/** Project-local configuration lives with the project, never in ~/.kodo. */
export const projectKodoDir      = (workspace) => path.join(workspace, ".kodo");
export const projectSettingsPath = (workspace) => path.join(workspace, ".kodo", "settings.json");
export const projectInstructions = (workspace) => path.join(workspace, "KODO.md");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Atomic write: a crash mid-write must not leave a truncated runtime-state or
 * config file behind, because the next command would then read it as "no server
 * running" (config) or fail to parse it at all. Write a sibling temp file, then
 * rename — rename is atomic within a filesystem.
 */
export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  return file;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
