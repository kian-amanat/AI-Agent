/**
 * services/hooks.mjs
 *
 * Kodo's hook engine — user-defined automation that runs at fixed points in a
 * session, modelled on Claude Code's lifecycle hooks.
 *
 * CONFIG SHAPE (.kodo/settings.json), Claude Code's grouped form:
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "bash|write_file",
 *         "hooks": [{ "type": "command", "command": "./guard.sh", "timeout": 10 }] }
 *     ],
 *     "PostToolUse": [
 *       { "matcher": "edit_file", "hooks": [{ "type": "command", "command": "prettier --write {file}" }] }
 *     ]
 *   }
 *
 * Kodo's original flat form is still honoured and normalised into the above:
 *
 *   "hooks": { "postEdit": "prettier --write {file}", "stop": "npm run typecheck" }
 *
 * HANDLER TYPES — command | http | mcp_tool | prompt | agent.
 * Not every event accepts every type (see EVENT_HANDLER_TYPES): session and
 * setup events run before a model is necessarily available, so they are
 * command/mcp_tool only, mirroring Claude Code.
 *
 * DECISION PROTOCOL (how a hook influences the run):
 *   • exit code 2         → block, with stderr as the reason (Claude Code's convention)
 *   • stdout JSON         → { decision: "block"|"approve", reason, permissionDecision,
 *                             hookSpecificOutput: { additionalContext, ... } }
 *   • any other non-zero  → non-fatal: logged, run continues (a broken hook must
 *                           never take down the user's task)
 *
 * Handlers for one event run in PARALLEL and identical handlers are deduplicated,
 * so the same command declared at user and project scope executes once.
 */

import { spawn } from "child_process";
import path from "path";
import { promises as fs } from "fs";

import { sanitizedChildEnv } from "../utils/process.util.mjs";

// Every lifecycle event Kodo recognises. Unknown names in settings are
// reported rather than silently ignored — a typo in a hook name is otherwise
// invisible and looks like the hook "just didn't fire".
export const HOOK_EVENTS = [
  "Setup", "SessionStart", "InstructionsLoaded", "ConfigChange",
  "UserPromptSubmit", "UserPromptExpansion", "MessageDisplay",
  "PreToolUse", "PermissionRequest", "PermissionDenied",
  "PostToolUse", "PostToolUseFailure", "PostToolBatch",
  "Notification",
  "SubagentStart", "SubagentStop",
  "TaskCreated", "TaskCompleted", "TeammateIdle",
  "Stop", "StopFailure",
  "PreCompact", "PostCompact",
  "WorktreeCreate", "WorktreeRemove",
  "Elicitation", "ElicitationResult",
  "CwdChanged", "FileChanged", "SessionEnd",
];

const ALL_TYPES = ["command", "http", "mcp_tool", "prompt", "agent"];
const NO_MODEL_TYPES = ["command", "http", "mcp_tool"];
const SETUP_TYPES = ["command", "mcp_tool"];

// Which handler types each event accepts. Events that can involve model
// reasoning allow prompt/agent; the rest are limited to side-effect handlers.
export const EVENT_HANDLER_TYPES = Object.fromEntries(HOOK_EVENTS.map((e) => {
  if (e === "SessionStart" || e === "Setup") return [e, SETUP_TYPES];
  if ([
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
    "PermissionRequest", "PermissionDenied", "Stop", "SubagentStop",
    "TaskCreated", "TaskCompleted", "TeammateIdle",
    "UserPromptSubmit", "UserPromptExpansion", "MessageDisplay",
  ].includes(e)) return [e, ALL_TYPES];
  return [e, NO_MODEL_TYPES];
}));

// Per-type defaults (seconds). A hook that hangs must not hang the agent.
const DEFAULT_TIMEOUTS = { command: 60, http: 30, mcp_tool: 30, prompt: 60, agent: 300 };
const SHORT_TIMEOUT_EVENTS = new Set(["SessionEnd", "MessageDisplay", "Notification"]);
const OUTPUT_MAX = 10_000;

// Kodo's original flat hooks → their lifecycle equivalents.
const LEGACY_MAP = { postEdit: { event: "PostToolUse", matcher: "edit_file|write_file" }, stop: { event: "Stop", matcher: "*" } };

function asArray(v) { return Array.isArray(v) ? v : v == null ? [] : [v]; }

/**
 * Normalise any accepted config shape into
 *   { [event]: [{ matcher, handlers: [{type, ...}] }] }
 * Invalid entries are dropped and reported in `warnings` rather than throwing:
 * one bad hook must not disable every other one.
 */
export function normalizeHookConfig(raw) {
  const out = {};
  const warnings = [];
  if (!raw || typeof raw !== "object") return { hooks: out, warnings };

  const push = (event, matcher, handlers) => {
    if (!handlers.length) return;
    (out[event] ||= []).push({ matcher: matcher || "*", handlers });
  };

  for (const [key, value] of Object.entries(raw)) {
    // Legacy flat form: "postEdit": "prettier --write {file}"
    if (LEGACY_MAP[key]) {
      if (typeof value !== "string" || !value.trim()) continue;
      const { event, matcher } = LEGACY_MAP[key];
      push(event, matcher, [{ type: "command", command: value, timeout: DEFAULT_TIMEOUTS.command, _legacy: key }]);
      continue;
    }

    if (!HOOK_EVENTS.includes(key)) {
      warnings.push(`Unknown hook event "${key}" — ignored. Valid events: ${HOOK_EVENTS.join(", ")}`);
      continue;
    }

    const allowed = EVENT_HANDLER_TYPES[key];
    for (const group of asArray(value)) {
      if (!group || typeof group !== "object") continue;
      const handlers = [];
      for (const h of asArray(group.hooks ?? group.handlers)) {
        if (!h || typeof h !== "object") continue;
        const type = String(h.type || "command");
        if (!ALL_TYPES.includes(type)) { warnings.push(`Hook ${key}: unknown type "${type}" — ignored.`); continue; }
        if (!allowed.includes(type)) {
          warnings.push(`Hook ${key}: type "${type}" is not supported for this event (allowed: ${allowed.join(", ")}) — ignored.`);
          continue;
        }
        if (type === "command" && typeof h.command !== "string") { warnings.push(`Hook ${key}: command handler needs a "command" string — ignored.`); continue; }
        if (type === "http" && typeof h.url !== "string") { warnings.push(`Hook ${key}: http handler needs a "url" — ignored.`); continue; }
        if (type === "mcp_tool" && typeof h.tool !== "string") { warnings.push(`Hook ${key}: mcp_tool handler needs a "tool" — ignored.`); continue; }
        if ((type === "prompt" || type === "agent") && typeof h.prompt !== "string") { warnings.push(`Hook ${key}: ${type} handler needs a "prompt" — ignored.`); continue; }
        handlers.push({
          ...h,
          type,
          timeout: Number(h.timeout) > 0
            ? Number(h.timeout)
            : (SHORT_TIMEOUT_EVENTS.has(key) ? 5 : DEFAULT_TIMEOUTS[type]),
        });
      }
      push(key, typeof group.matcher === "string" ? group.matcher : "*", handlers);
    }
  }

  return { hooks: out, warnings };
}

// A matcher is "*" / "" (everything) or a regex tested against the subject
// (tool name, file path, …), anchored so "bash" doesn't match "bash_output".
export function matcherApplies(matcher, subject) {
  const m = String(matcher ?? "*").trim();
  if (!m || m === "*") return true;
  if (subject == null) return false;
  try { return new RegExp(`^(?:${m})$`).test(String(subject)); }
  catch { return m === String(subject); } // invalid regex → literal compare
}

// Identical handlers declared at several scopes should execute once.
function handlerKey(h) {
  return JSON.stringify([h.type, h.command ?? null, h.url ?? null, h.tool ?? null, h.prompt ?? null, h.args ?? null]);
}

function truncate(s) {
  const t = String(s ?? "");
  return t.length > OUTPUT_MAX ? `${t.slice(0, OUTPUT_MAX)}…[truncated]` : t;
}

// ── Handler execution ────────────────────────────────────────────────────────

/**
 * Run a `command` hook handler.
 *
 * `runtime` decides WHERE. A project's hooks are the project's own shell
 * commands, and under `--sandbox` they must run wherever the agent's other
 * commands run: PreToolUse/PostToolUse fire inside every tool call, so a
 * host-side spawn here meant a confined run was executing project shell on the
 * host hundreds of times per task — one of the widest escapes in the surface.
 *
 * Session-level hooks (Setup, SessionStart, SessionEnd) fire outside any run,
 * before a runtime exists, and stay host-side by necessity. See docs/mcp.md and
 * docs/sandboxing.md for the boundary.
 */
function runCommand(handler, { cwd, payload, signal, runtime = null }) {
  if (runtime) {
    // Bounded the same way the host path is, and cancelled by the same signal.
    const timeoutMs = (handler.timeout || 60) * 1000;
    return runtime.exec(handler.command, { timeoutMs }).then((res) => ({
      ok: res.exit_code === 0,
      exitCode: res.exit_code,
      stdout: String(res.stdout || "").slice(0, OUTPUT_MAX),
      stderr: String(res.stderr || "").slice(0, OUTPUT_MAX),
    })).catch((err) => ({ ok: false, exitCode: null, stdout: "", stderr: String(err?.message || err) }));
  }

  // {placeholders} let a hook receive context without parsing JSON, e.g.
  // "prettier --write {file}". The full payload is also on stdin.
  const command = String(handler.command).replace(/\{(\w+)\}/g, (whole, key) =>
    payload?.[key] != null ? String(payload[key]) : whole);

  // Adding a listener to an ALREADY-aborted signal never fires, so an aborted
  // run would otherwise still execute its hooks to completion. Check upfront.
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, aborted: true, exitCode: null, stdout: "", stderr: "aborted before start" });
  }

  return new Promise((resolve) => {
    let child;
    let onAbort = null;
    try {
      child = spawn(command, { cwd, shell: true, env: { ...sanitizedChildEnv(), KODO_HOOK_EVENT: String(payload?.event || "") } });
    } catch (err) {
      resolve({ ok: false, exitCode: null, stdout: "", stderr: String(err?.message || err) });
      return;
    }

    let stdout = "", stderr = "", settled = false;
    // `onAbort` is attached to a RUN-SCOPED signal that outlives this call, so
    // it must be detached when the child settles. Without this, every hook
    // firing in a run leaves a listener behind and Node warns about a leak
    // after ~10 — a single run easily fires hundreds.
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener?.("abort", onAbort);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish({ ok: false, timedOut: true, exitCode: null, stdout: truncate(stdout), stderr: `hook timed out after ${handler.timeout}s` });
    }, handler.timeout * 1000);
    timer.unref?.();

    onAbort = () => { try { child.kill("SIGTERM"); } catch {} finish({ ok: false, aborted: true, exitCode: null, stdout: "", stderr: "aborted" }); };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish({ ok: false, exitCode: null, stdout: "", stderr: String(err?.message || err) }));
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) }));

    try { child.stdin.end(JSON.stringify(payload ?? {})); } catch { /* hook may not read stdin */ }
  });
}

async function runHttp(handler, { payload, signal }) {
  if (signal?.aborted) {
    return { ok: false, aborted: true, exitCode: null, stdout: "", stderr: "aborted before start" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), handler.timeout * 1000);
  timer.unref?.();
  // Detached in `finally` — a run-scoped signal must not accumulate one
  // listener per HTTP hook invocation.
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const res = await fetch(handler.url, {
      method: handler.method || "POST",
      headers: { "content-type": "application/json", ...(handler.headers || {}) },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const text = truncate(await res.text());
    return { ok: res.ok, exitCode: res.ok ? 0 : 1, stdout: text, stderr: res.ok ? "" : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, exitCode: null, stdout: "", stderr: err?.name === "AbortError" ? `hook timed out after ${handler.timeout}s` : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

async function runMcpTool(handler, { payload, deps }) {
  if (typeof deps?.callMcpTool !== "function") {
    return { ok: false, exitCode: null, stdout: "", stderr: "mcp_tool hooks are unavailable in this context" };
  }
  try {
    const r = await deps.callMcpTool(handler.tool, { ...(handler.args || {}), ...payload });
    return { ok: r?.success !== false, exitCode: r?.success === false ? 1 : 0, stdout: truncate(r?.output ?? ""), stderr: truncate(r?.error ?? "") };
  } catch (err) {
    return { ok: false, exitCode: null, stdout: "", stderr: String(err?.message || err) };
  }
}

async function runPrompt(handler, { payload, deps }) {
  if (typeof deps?.runPrompt !== "function") {
    return { ok: false, exitCode: null, stdout: "", stderr: "prompt hooks are unavailable in this context" };
  }
  try {
    const text = await deps.runPrompt({
      prompt: `${handler.prompt}\n\n<event_payload>\n${JSON.stringify(payload ?? {}, null, 2)}\n</event_payload>`,
      timeoutMs: handler.timeout * 1000,
    });
    return { ok: true, exitCode: 0, stdout: truncate(text), stderr: "" };
  } catch (err) {
    return { ok: false, exitCode: null, stdout: "", stderr: String(err?.message || err) };
  }
}

async function runAgent(handler, { payload, deps }) {
  if (typeof deps?.runAgent !== "function") {
    return { ok: false, exitCode: null, stdout: "", stderr: "agent hooks are unavailable in this context" };
  }
  try {
    const text = await deps.runAgent({
      prompt: `${handler.prompt}\n\n<event_payload>\n${JSON.stringify(payload ?? {}, null, 2)}\n</event_payload>`,
      timeoutMs: handler.timeout * 1000,
    });
    return { ok: true, exitCode: 0, stdout: truncate(text), stderr: "" };
  } catch (err) {
    return { ok: false, exitCode: null, stdout: "", stderr: String(err?.message || err) };
  }
}

const RUNNERS = { command: runCommand, http: runHttp, mcp_tool: runMcpTool, prompt: runPrompt, agent: runAgent };

// Parse a handler's stdout as the structured decision protocol; plain text is
// treated as context rather than an error, so simple echo hooks still work.
export function parseHookOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) return { json: null, text };
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

/**
 * Fire one event. Returns an aggregate decision plus every handler's result.
 *
 *   decision: "block" | "allow" | "continue"
 *   reason:   why it was blocked (fed back to the model)
 *   context:  additionalContext strings hooks contributed
 *
 * BLOCKING PRECEDENCE: any single blocking handler blocks. Handlers run in
 * parallel, so a block from one does not cancel the others' side effects —
 * that matches Claude Code and keeps behaviour deterministic.
 */
export async function fireHookEvent(event, payload, {
  config, cwd, subject = null, signal = null, deps = {}, emit = null,
  // When present, `command` handlers execute HERE rather than on the host.
  // Threaded from ctx.runtime by the agent loop's fireHook wrapper.
  runtime = null,
} = {}) {
  const groups = config?.[event] || [];
  if (!groups.length) return { fired: false, decision: "continue", reason: "", context: [], results: [] };

  const seen = new Set();
  const selected = [];
  for (const group of groups) {
    if (!matcherApplies(group.matcher, subject)) continue;
    for (const handler of group.handlers) {
      const key = handlerKey(handler);
      if (seen.has(key)) continue; // dedupe identical handlers across scopes
      seen.add(key);
      selected.push(handler);
    }
  }
  if (!selected.length) return { fired: false, decision: "continue", reason: "", context: [], results: [] };

  const fullPayload = { event, ...(payload || {}) };
  const settled = await Promise.all(selected.map(async (handler) => {
    const started = Date.now();
    const raw = await RUNNERS[handler.type](handler, { cwd, payload: fullPayload, signal, deps, runtime });
    return { handler, durationMs: Date.now() - started, ...raw };
  }));

  let decision = "continue";
  let reason = "";
  let updatedPrompt = null;
  const context = [];

  for (const r of settled) {
    const { json, text } = parseHookOutput(r.stdout);

    // exit code 2 is the documented "block" signal; stderr carries the reason.
    const blockedByExitCode = r.exitCode === 2;
    const blockedByJson = json?.decision === "block"
      || json?.permissionDecision === "deny"
      || json?.hookSpecificOutput?.permissionDecision === "deny";

    if (blockedByExitCode || blockedByJson) {
      decision = "block";
      reason = [reason, json?.reason || json?.permissionDecisionReason
        || json?.hookSpecificOutput?.permissionDecisionReason || r.stderr || text].filter(Boolean).join("\n");
      r.blocked = true;
    } else if (json?.permissionDecision === "allow" || json?.hookSpecificOutput?.permissionDecision === "allow") {
      if (decision !== "block") decision = "allow";
    }

    const extra = json?.hookSpecificOutput?.additionalContext ?? json?.additionalContext;
    if (extra) context.push(String(extra));

    // Prompt rewriting must be OPT-IN and explicit: a hook has to name
    // `updatedPrompt`. Treating arbitrary stdout as a replacement prompt would
    // let any logging/echo hook silently hijack what the user asked for.
    const rewritten = json?.hookSpecificOutput?.updatedPrompt ?? json?.updatedPrompt;
    if (typeof rewritten === "string" && rewritten.trim()) updatedPrompt = rewritten;

    // A hook that simply failed (non-zero, not 2) is a broken hook, not a veto:
    // warn loudly but let the user's actual task proceed.
    if (!r.ok && !r.blocked && !blockedByExitCode) {
      const label = r.handler.command || r.handler.url || r.handler.tool || r.handler.type;
      console.warn(`[Hooks] ${event} handler failed (${String(label).slice(0, 80)}): ${r.stderr || `exit ${r.exitCode}`}`);
    }
  }

  if (decision === "block") {
    emit?.({ type: "progress", stage: "planning", message: `🪝 ${event} blocked: ${String(reason).slice(0, 100)}` });
  }

  return { fired: true, decision, reason: reason.trim(), context, updatedPrompt, results: settled };
}

/**
 * Bind a hook dispatcher to a workspace so callers outside the agent loop
 * (the HTTP route, session lifecycle) can fire events without re-reading
 * settings or knowing how handlers execute. Config is read once per runner.
 */
export async function createHookRunner({ workspacePath, deps = {}, emit = null, signal = null } = {}) {
  const { hooks, warnings, mtimeMs } = await loadHookConfig(workspacePath);
  const fire = (event, payload, opts = {}) =>
    fireHookEvent(event, payload, { config: hooks, cwd: workspacePath, deps, emit, signal, ...opts });
  return { fire, config: hooks, warnings, mtimeMs };
}

// ── Settings loading (hot-reloadable) ────────────────────────────────────────

/**
 * Load and normalise hooks for a workspace. `mtimeMs` lets a caller detect a
 * changed settings file and fire ConfigChange without restarting the session.
 */
export async function loadHookConfig(workspacePath) {
  const file = path.join(workspacePath, ".kodo", "settings.json");
  try {
    const stat = await fs.stat(file);
    const raw = JSON.parse(await fs.readFile(file, "utf-8"));
    const { hooks, warnings } = normalizeHookConfig(raw?.hooks);
    for (const w of warnings) console.warn(`[Hooks] ${w}`);
    return { hooks, warnings, mtimeMs: stat.mtimeMs, source: file };
  } catch {
    return { hooks: {}, warnings: [], mtimeMs: 0, source: file };
  }
}

// Flatten a config for display — backs a /hooks inspector.
export function describeHookConfig(config) {
  const rows = [];
  for (const event of HOOK_EVENTS) {
    for (const group of config?.[event] || []) {
      for (const h of group.handlers) {
        rows.push({
          event,
          matcher: group.matcher,
          type: h.type,
          target: h.command || h.url || h.tool || (h.prompt ? `${String(h.prompt).slice(0, 60)}…` : ""),
          timeout: h.timeout,
          legacy: h._legacy || null,
        });
      }
    }
  }
  return rows;
}
