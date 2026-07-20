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
 * Tools: read_file, write_file, edit_file, bash, grep, glob, list_files,
 *        todo_write, list_memory_topics, read_memory_topic, load_skill,
 *        web_search, fetch_url, ask_user
 *
 * Safety & UX preserved from the old pipeline:
 *   - pre-write syntax/structural validation (utils/syntax.util.mjs)
 *   - .agent-history undo snapshots (same meta.json format the undo service reads)
 *   - SSE events the existing UI understands: progress, file_diff, plan_preview, todo, question
 *   - "ask" permission mode: pause for user approval before the FIRST mutation
 *   - "plan" permission mode: mutating tools disabled; the agent presents a plan
 *   - post-edit hooks from {workspace}/.kodo/hooks.json (e.g. prettier)
 *   - ask_user tool: the agent can pause and ask a clarifying question mid-task
 *     (not just approve/reject a plan) instead of guessing — mirrors Claude
 *     Code's own AskUserQuestion behavior. Answered via POST /answer/:requestId.
 */

import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { AIMessage } from "@langchain/core/messages";

import { chatWithTools } from "../../services/agentChat.mjs";
import { readMemoryTopic, listMemoryTopics, loadMemoryIndex } from "../../services/agentMemory.mjs";
import { validateSyntax, writeFileAtomic } from "../../utils/syntax.util.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

const MAX_ITERATIONS = 25;
const MAX_FILE_BYTES = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 8_000;
const MAX_CONV_MSGS = 48;
const HUNK_MAX = 4_000;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo",
  ".cache", "out", ".agent-history", ".kodo", "uploads", "temp_audio",
  ".claude", ".vscode", ".idea",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".json", ".md", ".yaml", ".yml", ".py", ".html", ".txt",
]);

// ── Filesystem helpers ────────────────────────────────────────────────────────

async function safeStat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

function safeResolve(root, relPath) {
  const abs = path.resolve(root, String(relPath || "").trim());
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  return abs;
}

async function readFileSafe(absPath, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = await safeStat(absPath);
    if (!stat?.isFile()) return null;
    if (stat.size > maxBytes) {
      const fd = await fs.open(absPath, "r");
      const buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, 0);
      await fd.close();
      return buf.toString("utf-8") + `\n\n... [truncated at ${maxBytes} bytes — use start_line/end_line to read more]`;
    }
    return await fs.readFile(absPath, "utf-8");
  } catch { return null; }
}

export async function walkWorkspace(root, maxDepth = 8, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth) return results;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const abs = path.join(root, entry.name);
    const rel = entry.name;
    const ext = path.extname(entry.name).toLowerCase();

    if (entry.isDirectory()) {
      results.push({ path: rel, isDir: true });
      const children = await walkWorkspace(abs, maxDepth, currentDepth + 1);
      results.push(...children.map((c) => ({ ...c, path: `${rel}/${c.path}` })));
    } else if (CODE_EXTENSIONS.has(ext)) {
      results.push({ path: rel, isDir: false });
    }
  }
  return results;
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
]);

const BASH_DENY_RE = /\b(sudo|shutdown|reboot|halt|poweroff|mkfs|chown|chmod\s+777\s+\/|launchctl|systemctl)\b|rm\s+(-[a-zA-Z]*\s+)*(\/|~)(\s|$)|>\s*\/dev\/(sd|disk)|curl[^|;&]*\|\s*(ba|z)?sh|wget[^|;&]*\|\s*(ba|z)?sh|:\s*\(\)\s*\{/;

export function validateBashCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return "command is required";
  if (cmd.length > 2000) return "command too long";
  if (BASH_DENY_RE.test(cmd)) return "command blocked by safety policy (destructive or privileged operation)";

  // Check the first token of every pipeline/sequence segment against the allowlist.
  const segments = cmd.split(/(?:\|\||&&|;|\|)/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const first = seg.replace(/^[({\s]+/, "").split(/\s+/)[0];
    if (!first) continue;
    const base = path.basename(first);
    if (first.startsWith("$") || first.startsWith("VAR=")) continue; // env prefix — check next token is too strict; allow
    if (!BASH_ALLOWED_CMDS.has(base)) {
      return `command "${base}" is not in the allowed list (${[...BASH_ALLOWED_CMDS].slice(0, 12).join(", ")}, …)`;
    }
    // rm may only touch relative paths inside the workspace
    if (base === "rm" && /(^|\s)(\/|~)/.test(seg.slice(2))) {
      return "rm may only be used with relative paths inside the workspace";
    }
  }
  return null;
}

// Portable shell resolution: a hardcoded "/bin/zsh" only exists on macOS by
// default and breaks every Linux/CI/Docker/Windows deployment outright. Prefer
// the user's actual login shell, fall back to bash (near-universal on POSIX),
// and use cmd.exe on Windows via its own argument convention.
function resolveShell() {
  if (process.platform === "win32") {
    return { bin: process.env.ComSpec || "cmd.exe", flag: "/c" };
  }
  return { bin: process.env.SHELL || "/bin/bash", flag: "-c" };
}

function runBash(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const { bin, flag } = resolveShell();
    const child = spawn(bin, [flag, command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { if (stdout.length < 200_000) stdout += d.toString(); });
    child.stderr.on("data", (d) => { if (stderr.length < 200_000) stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        timed_out: signal === "SIGTERM" || signal === "SIGKILL",
        stdout: stdout.slice(0, MAX_TOOL_OUTPUT_CHARS / 2),
        stderr: stderr.slice(0, MAX_TOOL_OUTPUT_CHARS / 2),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: null, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
  });
}

// ── grep (ripgrep-backed, grep fallback) ─────────────────────────────────────

let _grepTool = null; // "rg" | "grep"
async function detectGrepTool() {
  if (_grepTool) return _grepTool;
  const probeCmd = process.platform === "win32" ? "where rg" : "which rg";
  const probe = await runBash(probeCmd, PROJECT_ROOT, 5000);
  _grepTool = probe.exit_code === 0 ? "rg" : "grep";
  return _grepTool;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function grepWorkspace(root, pattern, fileGlob) {
  const tool = await detectGrepTool();
  const excludes = [...IGNORE_DIRS];
  let cmd;
  if (tool === "rg") {
    const globArg = fileGlob ? ` -g ${shellQuote(fileGlob)}` : "";
    cmd = `rg -n --no-heading -S -m 200 --max-columns 240 ${excludes.map((d) => `-g '!${d}'`).join(" ")}${globArg} ${shellQuote(pattern)} .`;
  } else {
    const includeArg = fileGlob ? ` --include=${shellQuote(fileGlob)}` : "";
    cmd = `grep -rn -i ${excludes.map((d) => `--exclude-dir=${d}`).join(" ")}${includeArg} ${shellQuote(pattern)} . | head -200`;
  }
  const res = await runBash(cmd, root, 20_000);
  const lines = (res.stdout || "").split("\n").filter(Boolean).slice(0, 120);
  return { matches: lines, count: lines.length };
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
const MAX_WEB_TEXT_CHARS = 12_000;
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

export async function fetchUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch { return { success: false, error: `Invalid URL: ${rawUrl}` }; }
  if (!/^https?:$/.test(url.protocol)) return { success: false, error: "Only http/https URLs are allowed" };
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

async function webSearch(query) {
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

// ── Post-edit hooks ───────────────────────────────────────────────────────────

async function loadHooks(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, ".kodo", "hooks.json"), "utf-8")); }
  catch { return {}; }
}

async function runPostEditHook(root, relPath, hooks, emit) {
  const cmd = hooks?.postEdit;
  if (!cmd || typeof cmd !== "string") return;
  const finalCmd = cmd.replaceAll("{file}", shellQuote(relPath));
  const invalid = validateBashCommand(finalCmd);
  if (invalid) { console.warn(`[AgentLoop] postEdit hook rejected: ${invalid}`); return; }
  emit?.({ type: "progress", stage: "executing", message: `hook: ${finalCmd.slice(0, 80)}` });
  const res = await runBash(finalCmd, root, 30_000);
  if (res.exit_code !== 0) console.warn(`[AgentLoop] postEdit hook failed (${res.exit_code}): ${String(res.stderr).slice(0, 200)}`);
}

// ── Enforced verification ─────────────────────────────────────────────────────
// The model only reliably reacts to checks that fail LOUDLY (a syntax error, a
// failed edit). Bugs that pass typecheck but are visually/behaviorally broken
// (a dead style prop, a group-hover with no `group` ancestor, an unused var)
// slip straight through if verification is left entirely up to the model's own
// judgment. Running the project's real lint/typecheck here — unconditionally,
// after every run that touched frontend files — closes that gap regardless of
// whether the model remembered to check its own work.
const FRONTEND_PREFIX = "chatbot/my-chatbot-ui/";

async function autoVerifyFrontendEdits(root, editedFiles, emit) {
  const frontendFiles = editedFiles
    .filter((p) => p.startsWith(FRONTEND_PREFIX))
    .map((p) => p.slice(FRONTEND_PREFIX.length));
  if (frontendFiles.length === 0) return null;
  emit?.({ type: "progress", stage: "executing", message: "🔍 Auto-verifying: typecheck + lint..." });

  // Typecheck is whole-project by nature (tsc needs the full program to see
  // cross-file breakage) — fine here since the project's baseline typecheck
  // is clean. Lint is scoped to ONLY the files this run touched: a bare
  // `npm run lint` runs across the whole app, and a repo can easily carry
  // pre-existing lint errors in files the agent never touched — that would
  // fail this gate on every single edit regardless of what actually changed.
  const lintTargets = frontendFiles.map((f) => shellQuote(f)).join(" ");
  const [typecheck, lint] = await Promise.all([
    runBash("npm --prefix chatbot/my-chatbot-ui run typecheck", root, 120_000),
    runBash(`cd chatbot/my-chatbot-ui && npx eslint ${lintTargets}`, root, 120_000),
  ]);

  const failures = [];
  if (typecheck.exit_code !== 0) {
    failures.push(`TYPECHECK FAILED:\n${(typecheck.stdout + "\n" + typecheck.stderr).trim().slice(0, 3000)}`);
  }
  if (lint.exit_code !== 0) {
    failures.push(`LINT FAILED:\n${(lint.stdout + "\n" + lint.stderr).trim().slice(0, 3000)}`);
  }
  return failures.length ? failures.join("\n\n") : null;
}

// ── Tool schema ───────────────────────────────────────────────────────────────

const AGENT_TOOLS = [
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
      description: "Create a new file or fully overwrite an existing one. For partial changes to an existing file, prefer edit_file.",
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
      description: "Run a shell command in the workspace root (allowlisted: node, npm, npx, git, tsc, eslint, ls, grep, etc.). Use for: installing packages, running tests/typecheck (`npm --prefix chatbot/my-chatbot-ui run typecheck`), git status, moving files. Output is truncated; keep commands focused.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number", description: "Max runtime in ms (default 120000, max 300000)" },
        },
        required: ["command"],
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
];

const MUTATING_TOOLS = new Set(["edit_file", "write_file", "bash"]);
// bash commands that only read — exempt from ask-mode approval
const BASH_READONLY_RE = /^\s*(ls|cat|grep|rg|find|wc|head|tail|pwd|which|stat|du|tree|git\s+(status|log|diff|show|branch)|npm\s+(ls|view|outdated)|node\s+--check)\b[^;&|]*$/;

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt({ workspaceTree, kodoMd, memoryIndex, skillIndex, permissionMode }) {
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

  const kodoSection = kodoMd
    ? `\n## Project instructions (KODO.md)\n${kodoMd.slice(0, 6000)}\n`
    : "";

  const planModeSection = permissionMode === "plan"
    ? `\n## PLAN MODE ACTIVE\nMutating tools (edit_file, write_file, mutating bash) are DISABLED. Explore the workspace, then present a concrete implementation plan as your final text answer: files to change, what changes, in what order, and how to verify. Do NOT attempt edits.\n`
    : "";

  return `You are Kodo, an autonomous coding agent working directly in the user's workspace.

# How you work
1. UNDERSTAND — read the files involved before touching them. Use grep/glob to locate things; never guess file contents.
2. TRACK — for any request with 2+ distinct steps, maintain a todo list with todo_write and keep it updated as you go.
3. ACT — make focused, minimal edits with edit_file (preferred) or write_file (new files / full rewrites). Match the existing code style.
4. VERIFY — after code changes, check your work: run a typecheck or build via bash (frontend: \`npm --prefix chatbot/my-chatbot-ui run typecheck\`), re-read the edited region, or run tests. Fix what you broke before finishing.
5. FINISH — when done, reply with plain text (no tool calls): a concise summary of what changed, file by file, and how you verified it.

# Rules
- edit_file's old_string must match the file EXACTLY (copy it from read_file output, whitespace included) and be unique — include neighbouring lines to disambiguate.
- Never re-create a file that exists; read then edit it.
- Prefer several small edits over one giant rewrite. Rewrites lose the user's untouched code.
- If a tool call fails, read the error, adapt, and retry differently — don't repeat the identical call.
- Keep dependencies minimal; use bash \`npm install <pkg> --prefix <subproject>\` only when the task truly needs a new package.
- For UI/design/animation work: load the matching skill first (see list), respect the project's design tokens, and keep accessibility (contrast, reduced-motion) intact.
- Never touch .env, secrets, lockfiles, or files outside the workspace.

# Don't work blind — ask when it matters
Use ask_user before committing to a consequential guess: an ambiguous requirement with materially different implementations, a destructive/hard-to-reverse choice (deleting data, overwriting config, picking an irreversible approach), or missing information only the user has (which of several plausible targets, a credential/URL you don't have, a design preference with no existing convention to follow). Do NOT ask about anything discoverable by reading the code, grepping, or checking docs — do that instead. Do NOT ask about low-stakes details — just make a reasonable choice and mention it in your final summary. Keep it to at most one or two questions per task, and never combine ask_user with other tool calls in the same turn.
${planModeSection}${kodoSection}${memorySection}${skillSection}
# Workspace layout (partial)
${snapshot}
`;
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeTool(name, args, ctx) {
  const { root, emit, sessionId, requestId, hooks, editedFiles, todosRef, permissionMode, askUser } = ctx;
  try {
    switch (name) {
      case "read_file": {
        const relPath = String(args.path || "").trim();
        if (!relPath) return { success: false, error: "path is required" };
        const absPath = safeResolve(root, relPath);
        const content = await readFileSafe(absPath);
        if (content === null) return { success: false, error: `File not found: ${relPath}` };
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
        const absPath = safeResolve(root, relPath);
        const original = await readFileSafe(absPath);
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
        await writeFileAtomic(absPath, updated);
        await runPostEditHook(root, relPath, hooks, emit);
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
        const absPath = safeResolve(root, relPath);
        const existing = await readFileSafe(absPath);
        if (existing !== null && !ctx.readFiles.has(relPath)) {
          return { success: false, error: `${relPath} already exists — read it first, then use edit_file for changes (or write_file after reading, for a deliberate full rewrite).` };
        }

        const syntaxErr = validateSyntax(content, absPath);
        if (syntaxErr) {
          return { success: false, error: `Write rejected — content is broken: ${syntaxErr}. Fix and retry.` };
        }

        await snapshotForUndo(root, sessionId, requestId, relPath, absPath);
        await writeFileAtomic(absPath, content);
        await runPostEditHook(root, relPath, hooks, emit);
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
        const command = String(args.command || "").trim();
        const invalid = validateBashCommand(command);
        if (invalid) return { success: false, error: invalid };
        if (permissionMode === "plan" && !BASH_READONLY_RE.test(command)) {
          return { success: false, error: "Plan mode — only read-only commands are allowed." };
        }
        const timeout = Math.min(Number(args.timeout_ms) || 120_000, 300_000);
        emit?.({ type: "progress", stage: "executing", message: `$ ${command.slice(0, 100)}` });
        const res = await runBash(command, root, timeout);
        return { success: res.exit_code === 0, ...res };
      }

      case "grep": {
        const pattern = String(args.pattern || "").trim();
        if (!pattern) return { success: false, error: "pattern is required" };
        emit?.({ type: "progress", stage: "exploring", message: `grep "${pattern.slice(0, 60)}"` });
        const { matches, count } = await grepWorkspace(root, pattern, args.glob ? String(args.glob) : null);
        return { success: true, pattern, count, matches };
      }

      case "glob": {
        const pattern = String(args.pattern || "").trim();
        if (!pattern) return { success: false, error: "pattern is required" };
        const re = globToRegex(pattern.startsWith("**/") || pattern.includes("/") ? pattern : `**/${pattern}`);
        const files = ctx.workspaceSnapshot.filter((f) => !f.isDir && re.test(f.path)).map((f) => f.path).slice(0, 100);
        emit?.({ type: "progress", stage: "exploring", message: `glob ${pattern} — ${files.length} file(s)` });
        return { success: true, pattern, files };
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

      case "ask_user": {
        const question = String(args.question || "").trim();
        if (!question) return { success: false, error: "question is required" };
        if (!askUser) return { success: false, error: "Asking the user isn't available in this context — make your best judgment call and note the assumption in your final summary." };
        const options = Array.isArray(args.options)
          ? args.options.map((o) => ({ label: String(o?.label || "").slice(0, 80), description: String(o?.description || "").slice(0, 200) })).filter((o) => o.label).slice(0, 4)
          : [];
        emit?.({ type: "progress", stage: "planning", message: `❓ ${question.slice(0, 140)}` });
        try {
          const answer = await askUser({ question, header: String(args.header || "").slice(0, 20), options });
          return { success: true, answer };
        } catch (err) {
          return { success: false, error: `Question cancelled: ${String(err?.message || err)}` };
        }
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────

async function resolveCreds(modelRoute) {
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

// ── Main node ─────────────────────────────────────────────────────────────────

export async function agentLoopNode(state) {
  const {
    workspacePath, userMessage, modelRoute, emit,
    rememberedTargetFile = "", sessionId, requestId,
    permissionMode = "auto", approvalPromise = null, abortSignal = null,
    askUser = null,
  } = state;

  const root = workspacePath || PROJECT_ROOT;
  const cleanMessage = String(userMessage).split(/conversation memory:/i)[0].trim();
  const memoryTail = String(userMessage).slice(cleanMessage.length).trim();

  emit?.({ type: "progress", stage: "exploring", message: permissionMode === "plan" ? "📐 Plan mode — exploring..." : "🤖 Agent working..." });

  const creds = await resolveCreds(modelRoute);
  if (!creds.apiKey) {
    const msg = "No API key configured. Open Settings and add a model + API key.";
    emit?.({ type: "content", content: msg });
    return { finalAnswer: msg, editedFiles: [], messages: [new AIMessage(msg)] };
  }

  const [workspaceSnapshot, memoryIndex, skillIndex, hooks, kodoMd] = await Promise.all([
    walkWorkspace(root, 8),
    loadMemoryIndex(root),
    loadSkillIndex(root),
    loadHooks(root),
    readFileSafe(path.join(root, "KODO.md"), 24_000),
  ]);

  const systemPrompt = buildSystemPrompt({
    workspaceTree: workspaceSnapshot,
    kodoMd,
    memoryIndex,
    skillIndex,
    permissionMode,
  });

  // Seed context: files whose FULL relative path appears verbatim in the message
  // are certainly involved — preload them so the model doesn't spend a turn on it.
  const seedBlocks = [];
  const msgLower = cleanMessage.toLowerCase();
  const ctx = {
    root, emit, sessionId, requestId, hooks,
    editedFiles: new Map(),
    readFiles: new Set(),
    todosRef: { current: [] },
    workspaceSnapshot,
    permissionMode,
    askUser,
  };
  for (const f of workspaceSnapshot) {
    if (f.isDir || seedBlocks.length >= 3) continue;
    if (msgLower.includes(f.path.toLowerCase())) {
      const content = await readFileSafe(safeResolve(root, f.path));
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
    preloadedSkills,
  ].filter(Boolean).join("\n");

  const conversation = [{ role: "user", content: firstUserMsg }];
  const usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };

  // One tool-calling turn loop, reused for both the main pass and the bounded
  // post-verification fix-up pass — same LLM-call/tool-execution/context-trim
  // logic, parameterized only by iteration budget and whether the ask-mode
  // approval gate is still active (it's already past by the time a fix-up runs).
  async function runToolLoop({ iterationBudget, approvalState }) {
    let iteration = 0;
    let consecutiveErrors = 0;
    let finalAnswer = "";
    const onChunk = (chunk) => emit?.({ type: "content", content: chunk });

    while (iteration < iterationBudget) {
      if (abortSignal?.aborted) { finalAnswer = "Operation cancelled."; break; }
      iteration++;

      let message, callUsage;
      try {
        ({ message, usage: callUsage } = await chatWithTools({
          creds,
          system: systemPrompt,
          messages: conversation,
          tools: AGENT_TOOLS,
          maxTokens: 8_000,
          temperature: 0,
          signal: abortSignal || undefined,
          onChunk,
        }));
        usage.inputTokens += callUsage?.inputTokens || 0;
        usage.outputTokens += callUsage?.outputTokens || 0;
        usage.llmCalls++;
      } catch (err) {
        if (abortSignal?.aborted) { finalAnswer = "Operation cancelled."; break; }
        const errStr = String(err?.message || err);
        console.warn(`[AgentLoop] LLM error (iter ${iteration}):`, errStr.slice(0, 200));
        const isTransient = /\b(504|503|502|529|429)\b|timeout|timed out|ETIMEDOUT|ECONNRESET|overloaded/i.test(errStr);
        consecutiveErrors++;
        if (isTransient && consecutiveErrors < 3) {
          await new Promise((r) => setTimeout(r, 800 * consecutiveErrors));
          iteration--; // transient failures don't consume budget
          continue;
        }
        finalAnswer = `The AI provider failed after ${consecutiveErrors} attempt(s): ${errStr.slice(0, 200)}. Please try again.`;
        break;
      }
      consecutiveErrors = 0;

      conversation.push(message);

      // Plain text response = the agent is done.
      if (!message.tool_calls?.length) {
        finalAnswer = String(message.content || "").trim();
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

      const toolResults = [];
      for (const toolCall of toolCallsThisTurn) {
        if (abortSignal?.aborted) break;
        const toolName = toolCall.function.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}
        console.log(`[AgentLoop] ${iteration}/${iterationBudget} → ${toolName}(${JSON.stringify(args).slice(0, 140)})`);

        const result = await executeTool(toolName, args, ctx);

        const raw = JSON.stringify(result);
        const capped = raw.length > MAX_TOOL_OUTPUT_CHARS
          ? raw.slice(0, MAX_TOOL_OUTPUT_CHARS) + '..."[truncated]"}'
          : raw;
        toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: capped });
      }
      for (const deferred of deferredCalls) {
        toolResults.push({
          role: "tool",
          tool_call_id: deferred.id,
          content: JSON.stringify({ success: false, error: "Not run — you asked a question in the same turn. Wait for the answer, then re-issue this call on its own." }),
        });
      }
      conversation.push(...toolResults);

      // Context window management: keep the first user message; evict old middle
      // turns, shrinking evicted tool outputs instead of silently losing shape.
      if (conversation.length > MAX_CONV_MSGS) {
        const first = conversation[0];
        const keepTail = conversation.slice(-(MAX_CONV_MSGS - 8));
        const evicted = conversation.slice(1, conversation.length - keepTail.length);
        const digest = evicted
          .map((m) => {
            if (m.role === "assistant" && m.tool_calls?.length) return m.tool_calls.map((tc) => `→ ${tc.function.name}`).join(", ");
            if (m.role === "tool") return null;
            return String(m.content || "").slice(0, 120);
          })
          .filter(Boolean)
          .join(" | ");
        conversation.splice(0, conversation.length, first,
          { role: "user", content: `[Earlier turns compacted: ${digest.slice(0, 1000)}]\nFiles already read this session: ${[...ctx.readFiles].join(", ") || "(none)"}` },
          ...keepTail);
      }
    }

    return { finalAnswer, iterations: iteration };
  }

  const approvalState = { granted: permissionMode !== "ask", promise: approvalPromise };
  const mainResult = await runToolLoop({ iterationBudget: MAX_ITERATIONS, approvalState });
  let finalAnswer = mainResult.finalAnswer;

  if (mainResult.cancelled) {
    emit?.({ type: "content", content: finalAnswer });
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
      });
      finalAnswer = String(message.content || "").trim();
    } catch { /* fall through to the static message below */ }
    if (!finalAnswer) {
      finalAnswer = "Work stopped at the iteration limit before a summary could be produced.";
      if (!streamedAny) emit?.({ type: "content", content: finalAnswer });
    }
  }

  // Enforced verification: run the project's real typecheck/lint regardless of
  // whether the model chose to, and force one bounded fix-up pass on failure —
  // this is what makes a silently-broken change (dead style prop, missing
  // `group` ancestor, an unused var) actually get caught instead of reported
  // as done.
  if (!abortSignal?.aborted && ctx.editedFiles.size > 0) {
    const editedList = [...ctx.editedFiles.keys()];
    const failureReport = await autoVerifyFrontendEdits(root, editedList, emit);
    if (failureReport) {
      emit?.({ type: "progress", stage: "executing", message: "⚠️ Automated verification found issues — fixing..." });
      conversation.push({
        role: "user",
        content: `Automated verification (typecheck/lint) found problems your changes introduced. Fix them now, then reply with a final summary (no more tool calls once fixed).\n\n${failureReport.slice(0, 6000)}`,
      });
      const fixResult = await runToolLoop({ iterationBudget: 8, approvalState: null });
      if (fixResult.finalAnswer) {
        const sep = `\n\n---\n${fixResult.finalAnswer}`;
        finalAnswer += sep;
        // fixResult's own text already streamed via onChunk inside runToolLoop;
        // only the separator itself needs an explicit chunk.
        emit?.({ type: "content", content: "\n\n---\n" });
      }

      const secondCheck = await autoVerifyFrontendEdits(root, [...ctx.editedFiles.keys()], null);
      const note = secondCheck
        ? `\n\n⚠️ Verification still failing after one auto-fix attempt:\n${secondCheck.slice(0, 800)}`
        : `\n\n✅ Verified: typecheck and lint pass.`;
      finalAnswer += note;
      emit?.({ type: "content", content: note });
    } else {
      const note = `\n\n✅ Verified: typecheck and lint pass.`;
      finalAnswer += note;
      emit?.({ type: "content", content: note });
    }
  }

  const editedFiles = [...ctx.editedFiles.keys()];
  emit?.({ type: "usage", ...usage, model: creds.model });
  console.log(`[AgentLoop] Done: ${editedFiles.length} file(s) edited, ${usage.inputTokens}+${usage.outputTokens} tokens, ${usage.llmCalls} LLM call(s)`);

  return {
    finalAnswer,
    editedFiles,
    usage,
    messages: [new AIMessage(finalAnswer)],
  };
}
