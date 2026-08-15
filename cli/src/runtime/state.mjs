/**
 * src/runtime/state.mjs — durable knowledge of "is a Kodo server running?"
 *
 * A PID file is the classic way to get this wrong. The three failure modes this
 * module exists to prevent:
 *
 *  1. STALE PID — the server crashed, the file survived. `kodo ui start` then
 *     refuses to start ("already running") forever. Fixed by probing liveness
 *     with signal 0 and treating a dead PID as no server at all.
 *
 *  2. RECYCLED PID — the server died and the OS handed its PID to something
 *     unrelated. `kodo ui stop` would then kill a stranger's process. Fixed by
 *     recording an identity token at startup and requiring the live process to
 *     prove it holds the same one before any signal is sent. `kill` is never
 *     issued on the strength of a number in a file.
 *
 *  3. TORN WRITE — a crash mid-write leaves truncated JSON, and every later
 *     command reads it as "no server". Fixed by writing to a temp file and
 *     renaming (writeJsonAtomic).
 *
 * State is keyed by name ("ui", "server") so the two lifecycles never read each
 * other's file.
 */

import fs from "fs";
import path from "path";
import { ensureDir, readJson, runtimeDir, writeJsonAtomic } from "../paths.mjs";
import { identityMatches } from "./identity.mjs";
import { pidsListeningOn, commandOf, platformName } from "./procinfo.mjs";

export const stateFile = (name) => path.join(runtimeDir(), `${name}.json`);

/**
 * Does this PID exist AND is it ours to signal? `kill(pid, 0)` sends nothing;
 * it only performs the existence + permission check.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user. It exists —
    // which is the question asked — but it is emphatically not ours to kill,
    // and identity verification below will refuse it.
    return err.code === "EPERM";
  }
}

export function write(name, record) {
  ensureDir(runtimeDir());
  return writeJsonAtomic(stateFile(name), record);
}

export function clear(name) {
  try { fs.unlinkSync(stateFile(name)); return true; } catch { return false; }
}

/**
 * Read runtime state and reconcile it with reality.
 *
 * @returns {{status: "running"|"stopped"|"stale", record: object|null}}
 *   `stale` means a record existed but its process is gone; the caller decides
 *   whether to report it or silently reclaim it.
 */
export function read(name) {
  const record = readJson(stateFile(name), null);
  if (!record || typeof record !== "object" || !Number.isInteger(record.pid)) {
    return { status: "stopped", record: null };
  }
  if (!pidAlive(record.pid)) return { status: "stale", record };
  return { status: "running", record };
}

/**
 * Read, and reclaim a stale record in passing. Used by every command that only
 * cares whether a server is usable right now.
 */
export function readLive(name) {
  const { status, record } = read(name);
  if (status === "stale") {
    clear(name);
    return { status: "stopped", record: null, reclaimed: record };
  }
  return { status, record, reclaimed: null };
}

/**
 * Confirm the live process at `record.pid` really is the Kodo server we
 * recorded, by asking it. The server echoes its identity token on /health; a
 * recycled PID cannot produce it, and neither can an unrelated web server that
 * happens to hold the port.
 *
 * Returns false rather than throwing — an unverifiable process is simply not
 * ours to signal.
 */
export async function verifyIdentity(record, { timeoutMs = 1500 } = {}) {
  // EXTERNAL services (backend1's Fastify app, Next.js) are not ours to
  // instrument, so they cannot echo an identity hash. They still must not be
  // killed on the strength of a PID alone — that is the recycled-PID hazard
  // this function exists for — so identity is established from the process's
  // own command line instead: the recorded one has to still be what that PID is
  // running. A PID reused by something else will not match.
  if (record?.external) return verifyExternalIdentity(record);

  if (!record?.token || !record.port) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://${record.host || "127.0.0.1"}:${record.port}/health`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return false;
    const body = await res.json();
    return identityMatches(record.token, body?.identity);
  } catch {
    return false;
  }
}

/**
 * Confirm the PID we recorded is still the process serving the port we recorded.
 *
 * "Does this PID hold that listening socket" is the right identity question for
 * a server, and it is the one that survives reality: Next.js rewrites its own
 * process title to `next-server (v16.2.6)`, so comparing against the command we
 * spawned (`.../next/dist/bin/next`) failed every time — `kodo ui stop`
 * reported an identity mismatch and left the UI running as an orphan.
 *
 * Falls back to the recorded command when the port cannot be inspected, so a
 * machine without lsof degrades to a weaker check rather than to none.
 * Side-effect free by construction: the whole point is deciding whether
 * signalling is safe.
 */
function verifyExternalIdentity(record) {
  if (!Number.isInteger(record.pid)) return false;

  // "Does this PID hold that listening socket" is the right identity question
  // for a server, and it survives reality: Next.js rewrites its process title
  // to `next-server`, so comparing against the command we spawned failed every
  // time and left the UI running as an orphan.
  //
  // Platform differences live in procinfo.mjs — POSIX uses lsof/ps, Windows
  // uses netstat/tasklist. Both answer the same two questions.
  const holders = pidsListeningOn(record.port);
  if (holders !== null && holders.length) return holders.includes(record.pid);

  const command = commandOf(record.pid);
  if (command === null) {
    // No inspection tool at all. "Cannot verify" is NOT "verified as not ours",
    // and it must not be reported as a PID collision — that sends people
    // looking for a problem that does not exist.
    throw new Error(
      `Kodo cannot verify process identity on this system: no process-inspection tool is available ` +
      `(${platformName === "windows" ? "netstat/tasklist" : "lsof/ps"} could not be run). ` +
      "Refusing to signal PID " + record.pid + " without confirming what it is. " +
      "Stop the server from its own terminal instead.",
    );
  }

  if (!record.commandMarker) return false;
  // Windows reports an image name (`node.exe`), POSIX a full command line, so
  // match in whichever direction has the information.
  return command.includes(record.commandMarker)
    || (command.trim() !== "" && record.commandMarker.includes(command.trim()));
}

/** Health probe that does not require identity — used while waiting for boot. */
export async function probeHealth(host, port, { timeoutMs = 1000 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal })
      .finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
