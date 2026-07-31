/**
 * services/configWatcher.mjs
 *
 * Live reload for workspace configuration (.kodo/settings.json).
 *
 * Guarantees, in the order they matter:
 *   • ATOMIC SWAP    — `current` is replaced by a fully-parsed, validated
 *                      snapshot or not at all. A reader never observes a
 *                      half-applied config.
 *   • ROLLBACK       — invalid JSON, a partial write, or a failed validation
 *                      leaves the previous good config in place. Bad edits
 *                      degrade to "no change", never to "no hooks".
 *   • DEBOUNCE       — editors emit several fs events per save (write, rename,
 *                      chmod). One settle window collapses them into at most
 *                      one reload.
 *   • NO-OP DETECTION— content is hashed, so touching a file or rewriting it
 *                      byte-identically fires nothing. mtime alone is far too
 *                      noisy to be trustworthy here.
 *   • ONLY-ON-ACCEPT — ConfigChange is emitted *after* a new config is accepted,
 *                      never on the attempt.
 *
 * IN-FLIGHT RUNS ARE UNAFFECTED. The agent loop snapshots its hook config once
 * at run start (see agent_loop's `normalizeHookConfig(hooks)`); the watcher only
 * swaps the reference handed to FUTURE runs. A reload can never mutate a
 * conversation or interrupt a tool that is currently executing.
 */

import crypto from "crypto";
import path from "path";
import fsSync from "fs";
import { promises as fs } from "fs";
import { EventEmitter } from "events";

import { normalizeHookConfig } from "./hooks.mjs";

const DEBOUNCE_MS = 200;
const CONFIG_DIR = ".kodo";
const CONFIG_FILE = "settings.json";

function hash(text) {
  return crypto.createHash("sha1").update(text ?? "").digest("hex");
}

/**
 * Read + validate a workspace config.
 * Returns { ok, raw, hooks, warnings, digest, missing } — `ok:false` means the
 * caller must keep whatever it already had.
 */
export async function loadAndValidate(workspacePath) {
  const file = path.join(workspacePath, CONFIG_DIR, CONFIG_FILE);
  let text;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch (err) {
    // A missing file is a VALID state (no config), not a failure to roll back
    // from — otherwise deleting the file would freeze the old hooks forever.
    if (err.code === "ENOENT") {
      return { ok: true, missing: true, raw: {}, hooks: {}, warnings: [], digest: hash("") };
    }
    return { ok: false, error: `unreadable: ${err.message}`, digest: null };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // The common cause is reading mid-write; either way the old config stands.
    return { ok: false, error: `invalid JSON: ${err.message}`, digest: hash(text) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "settings.json must contain a JSON object", digest: hash(text) };
  }

  const { hooks, warnings } = normalizeHookConfig(raw.hooks);
  return { ok: true, missing: false, raw, hooks, warnings, digest: hash(text) };
}

export class ConfigWatcher extends EventEmitter {
  constructor({ workspacePath, debounceMs = DEBOUNCE_MS } = {}) {
    super();
    this.workspacePath = workspacePath;
    this.debounceMs = debounceMs;
    this.dir = path.join(workspacePath, CONFIG_DIR);
    this.watcher = null;
    this.timer = null;
    this.digest = null;
    this.current = { hooks: {}, raw: {}, warnings: [] };
    this.reloads = 0;
    this.rejected = 0;
  }

  /** Load the initial config, then begin watching. Idempotent. */
  async start() {
    if (this.watcher) return this.current;

    const initial = await loadAndValidate(this.workspacePath);
    if (initial.ok) {
      this.current = { hooks: initial.hooks, raw: initial.raw, warnings: initial.warnings };
      this.digest = initial.digest;
    }

    // Watch the DIRECTORY, not the file: editors and atomic writers replace
    // settings.json via rename, which detaches a file-level watch permanently.
    try {
      await fs.mkdir(this.dir, { recursive: true });
      this.watcher = fsSync.watch(this.dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== CONFIG_FILE) return;
        this._schedule();
      });
      this.watcher.on("error", (err) => this.emit("error", err));
    } catch (err) {
      this.emit("error", err);
    }
    return this.current;
  }

  _schedule() {
    // Collapse the burst an editor produces for one save.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this._reload(); }, this.debounceMs);
    this.timer.unref?.();
  }

  async _reload() {
    const next = await loadAndValidate(this.workspacePath);

    if (!next.ok) {
      this.rejected++;
      // Explicitly keep this.current — this is the rollback.
      this.emit("invalid", { error: next.error, keeping: this.current });
      console.warn(`[ConfigWatcher] ${this.workspacePath}: ${next.error} — keeping previous configuration`);
      return { changed: false, rejected: true, error: next.error };
    }

    if (next.digest === this.digest) {
      // Byte-identical: a touch, a chmod, or a re-save with no edits.
      return { changed: false, unchanged: true };
    }

    const previous = this.current;
    // Atomic swap: one assignment of an already-built object.
    this.current = { hooks: next.hooks, raw: next.raw, warnings: next.warnings };
    this.digest = next.digest;
    this.reloads++;

    this.emit("change", {
      workspacePath: this.workspacePath,
      source: path.join(this.dir, CONFIG_FILE),
      missing: !!next.missing,
      warnings: next.warnings,
      previousEvents: Object.keys(previous.hooks || {}),
      currentEvents: Object.keys(next.hooks || {}),
    });
    return { changed: true };
  }

  /** Force a re-read now, bypassing the debounce. Used by tests and /hooks. */
  async reloadNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return this._reload();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
    this.removeAllListeners();
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────
// One watcher per workspace, reference-counted by session so several sessions
// on the same workspace share a single fs watch and the last one out closes it.
// Without refcounting, ending one session would blind the others.

const watchers = new Map(); // workspacePath → { watcher, sessions:Set }

export async function acquireConfigWatcher(workspacePath, sessionId, onChange) {
  if (!workspacePath) return null;
  let entry = watchers.get(workspacePath);

  if (!entry) {
    const watcher = new ConfigWatcher({ workspacePath });
    entry = { watcher, sessions: new Set(), listeners: new Map() };
    watchers.set(workspacePath, entry);
    await watcher.start();
  }
  entry.sessions.add(sessionId);

  // Each session gets its own listener so its own hook runner fires the event.
  if (onChange && !entry.listeners.has(sessionId)) {
    const listener = (payload) => { void onChange({ ...payload, session_id: sessionId }); };
    entry.listeners.set(sessionId, listener);
    entry.watcher.on("change", listener);
  }
  return entry.watcher;
}

export function releaseConfigWatcher(workspacePath, sessionId) {
  const entry = watchers.get(workspacePath);
  if (!entry) return false;

  const listener = entry.listeners.get(sessionId);
  if (listener) { entry.watcher.off("change", listener); entry.listeners.delete(sessionId); }
  entry.sessions.delete(sessionId);

  if (entry.sessions.size === 0) {
    entry.watcher.stop();
    watchers.delete(workspacePath);
    return true; // fully closed
  }
  return false;    // still in use by another session
}

export function activeWatcherCount() { return watchers.size; }

export function getWatchedConfig(workspacePath) {
  return watchers.get(workspacePath)?.watcher.current || null;
}

// Test/shutdown helper.
export function disposeAllConfigWatchers() {
  for (const [, entry] of watchers) entry.watcher.stop();
  watchers.clear();
}
