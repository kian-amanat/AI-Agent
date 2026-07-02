/**
 * agentic_explore.mjs
 *
 * Agentic exploration loop: the model iteratively calls tools to gather
 * exactly the context it needs, then signals when it is ready to plan.
 *
 * Each tool result feeds directly into the model's next decision — nothing
 * is pre-scripted. The model decides whether to grep for a symbol, read a
 * specific file, follow an import, or declare "ready" based solely on what
 * it has seen so far. This is the same dynamic the Claude Code agentic loop
 * uses: gather context → take action → verify results, all driven by the
 * model rather than fixed node sequences.
 *
 * Replaces the rigid chain:
 *   investigate/explore → workspace_index → stacktrace_parser →
 *   symbol_search → grep_workspace → dependency_context
 */

import path from "path";
import fs from "fs/promises";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { AIMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

const MAX_LOOP_ITERATIONS = 12;
const MAX_FILE_BYTES = 80_000;
const MAX_GREP_RESULTS = 30;
const MAX_TOOL_OUTPUT_CHARS = 8_000;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build",
  "coverage", ".turbo", ".cache", "out", ".agent-history", "uploads",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".json", ".md", ".yaml", ".yml",
]);

// ── Tool definitions ──────────────────────────────────────────────────────────

const EXPLORATION_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the project. Call this before modifying any file — never guess at contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from project root" },
          start_line: { type: "number", description: "First line to read (1-indexed, optional)" },
          end_line: { type: "number", description: "Last line to read (1-indexed, optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_code",
      description:
        "Search for a string across all project files. Use to locate where a symbol, function, route, or component is defined or imported.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to search for" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and subdirectories under a path. Use to orient yourself in an unfamiliar directory.",
      parameters: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description: "Relative directory to list (omit for project root)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ready_to_plan",
      description:
        "Call this when you have gathered sufficient context to plan the changes. This ends the exploration phase and moves to planning.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "One sentence: what needs to change and why",
          },
          priority_files: {
            type: "array",
            items: { type: "string" },
            description: "Files that need to be edited, most important first",
          },
          root_cause: {
            type: "string",
            description: "For bugs: the root cause. For features: the pattern to follow.",
          },
        },
        required: ["summary", "priority_files"],
      },
    },
  },
];

// ── Filesystem helpers ────────────────────────────────────────────────────────

async function safeStat(p) {
  try { return await fs.stat(p); } catch { return null; }
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
      return buf.toString("utf-8") + `\n\n... [truncated at ${maxBytes} bytes]`;
    }

    return await fs.readFile(absPath, "utf-8");
  } catch { return null; }
}

async function walkWorkspace(root, maxDepth = 4, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth) return results;

  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const abs = path.join(root, entry.name);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    const ext = path.extname(entry.name).toLowerCase();

    if (entry.isDirectory()) {
      results.push({ path: rel, isDir: true });
      const children = await walkWorkspace(abs, maxDepth, currentDepth + 1);
      results.push(...children.map(c => ({ ...c, path: `${rel}/${c.path}` })));
    } else if (CODE_EXTENSIONS.has(ext)) {
      const stat = await safeStat(abs);
      results.push({ path: rel, isDir: false, size: stat?.size ?? 0 });
    }
  }

  return results;
}

async function grepWorkspace(root, query, maxResults = MAX_GREP_RESULTS) {
  const files = await walkWorkspace(root, 10);
  const codeFiles = files.filter(f => !f.isDir);
  const pattern = query.toLowerCase();
  const results = [];

  for (const file of codeFiles) {
    if (results.length >= maxResults) break;
    const absPath = path.join(root, file.path);
    const content = await readFileSafe(absPath, 300_000);
    if (!content) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(pattern)) {
        results.push({ file: file.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (results.length >= maxResults) break;
      }
    }
  }

  return results;
}

// ── Credential resolution (mirrors llm.mjs) ──────────────────────────────────

function loadSettingsSync() {
  try {
    const p = path.join(__dirname, "../../data/settings.json");
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return {}; }
}

function resolveClientCredentials(modelRoute) {
  if (modelRoute?.ok && modelRoute?.apiKey && modelRoute?.model) {
    return {
      apiKey: modelRoute.apiKey,
      baseURL: modelRoute.baseUrl || "https://api.openai.com/v1",
      model: modelRoute.model,
    };
  }

  const s = loadSettingsSync();
  if (s?.textApiKey && s?.textModel) {
    return {
      apiKey: s.textApiKey,
      baseURL: s.textBaseUrl || "https://api.openai.com/v1",
      model: s.textModel,
    };
  }
  if (s?.apiKey && s?.model) {
    return {
      apiKey: s.apiKey,
      baseURL: s.baseUrl || "https://api.openai.com/v1",
      model: s.model,
    };
  }

  return {
    apiKey: process.env.OPENAI_API_KEY || process.env.USER_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL || process.env.USER_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL || process.env.USER_MODEL || "gpt-4o-mini",
  };
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, root) {
  try {
    switch (name) {
      case "read_file": {
        const relPath = String(args.path || "").trim();
        if (!relPath) return { success: false, error: "path is required" };

        const absPath = path.resolve(root, relPath);
        if (!absPath.startsWith(root + path.sep) && absPath !== root) {
          return { success: false, error: "path escapes workspace" };
        }

        const content = await readFileSafe(absPath);
        if (content === null) return { success: false, error: `File not found: ${relPath}` };

        if (args.start_line || args.end_line) {
          const lines = content.split("\n");
          const start = Math.max(0, (Number(args.start_line) || 1) - 1);
          const end = Math.min(lines.length, Number(args.end_line) || lines.length);
          return {
            success: true,
            path: relPath,
            content: lines.slice(start, end).join("\n"),
            total_lines: lines.length,
          };
        }

        return { success: true, path: relPath, content, total_lines: content.split("\n").length };
      }

      case "grep_code": {
        const query = String(args.query || "").trim();
        if (!query) return { success: false, error: "query is required" };
        const matches = await grepWorkspace(root, query);
        return { success: true, query, matches, count: matches.length };
      }

      case "list_files": {
        const dir = String(args.dir || "").trim();
        const absDir = dir ? path.resolve(root, dir) : root;
        if (!absDir.startsWith(root)) return { success: false, error: "path escapes workspace" };
        const files = await walkWorkspace(absDir, 2);
        return {
          success: true,
          dir: dir || ".",
          entries: files.slice(0, 100).map(f => (f.isDir ? `DIR  ${f.path}` : `FILE ${f.path}`)),
        };
      }

      case "ready_to_plan":
        return { success: true, ready: true };

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(cleanMessage, workspaceTree) {
  const snapshot = workspaceTree
    .filter(f => f.isDir ? f.path.split("/").length <= 2 : true)
    .slice(0, 120)
    .map(f => (f.isDir ? `📁 ${f.path}/` : `   ${f.path}`))
    .join("\n");

  return `You are Kodo, an autonomous code agent in EXPLORATION MODE.

MISSION: Gather the precise context needed to implement the user's request, then signal ready.

TOOLS:
• read_file    — read any file (required before modifying it)
• grep_code    — search all files for a string or symbol
• list_files   — explore directory structure
• ready_to_plan — call when you have enough context; ends exploration

STRATEGIES BY REQUEST TYPE:

BUG FIX: grep for the error text → read the file with the bug → follow imports to root cause
EDIT/REFACTOR: find the target file → read it → read its imports if relevant
UI CHANGE: read the component AND its nearest layout/styles file
FEATURE: grep for similar existing code → read it → identify all files to touch

RULES:
1. Read every file you intend to modify — never guess contents
2. Follow imports only when they directly affect your change
3. Stop as soon as you have read all files you intend to edit
4. 4–8 tool calls is usually enough; do not over-explore
5. When you call ready_to_plan, list only the files you will actually change

WORKSPACE SNAPSHOT:
${snapshot}

USER REQUEST: "${cleanMessage}"

Call tools now. Start with what is most directly relevant.`;
}

// ── Main node ─────────────────────────────────────────────────────────────────

export async function agenticExploreNode(state) {
  const {
    workspacePath,
    userMessage,
    modelRoute,
    emit,
    rememberedTargetFile = "",
    fileContext: existingContext = [],
  } = state;

  emit?.({ type: "progress", stage: "exploring", message: "🔍 Exploring workspace..." });

  const root = workspacePath || PROJECT_ROOT;
  const cleanMessage = String(userMessage).split(/conversation memory:/i)[0].trim();

  // Workspace snapshot for the system prompt
  const workspaceTree = await walkWorkspace(root, 3);

  // Resolve API credentials
  const { apiKey, baseURL, model } = resolveClientCredentials(modelRoute);
  if (!apiKey) {
    console.error("[AgenticExplore] No API key — skipping exploration");
    return {
      fileContext: existingContext,
      investigation: {
        likelyRootCause: "No API key configured",
        priorityFiles: [],
        evidence: [],
        confidence: 0,
      },
      messages: [new AIMessage("Exploration skipped: no API key configured")],
    };
  }

  const isThinkingModel = /thinking|r1\b|reasoner/i.test(model);
  // Thinking models stream to keep the connection alive past gateway timeouts.
  const client = new OpenAI({ apiKey, baseURL, timeout: isThinkingModel ? 600_000 : 120_000, maxRetries: 0 });
  const systemPrompt = buildSystemPrompt(cleanMessage, workspaceTree);

  // Seed the conversation — include remembered file as context if available
  const initialContent = rememberedTargetFile
    ? `${cleanMessage}\n\n[Context: the user was previously working on "${rememberedTargetFile}"]`
    : cleanMessage;

  const conversationMessages = [{ role: "user", content: initialContent }];

  const loadedFiles = new Map(); // relPath → { path, content, size, score }
  let readySignal = null;
  let iteration = 0;

  // ── Agentic loop ──────────────────────────────────────────────────────────

  while (iteration < MAX_LOOP_ITERATIONS) {
    iteration++;
    console.log(`[AgenticExplore] Iteration ${iteration}/${MAX_LOOP_ITERATIONS}`);

    let assistantMsg;
    try {
      if (isThinkingModel) {
        // Stream tool calls to avoid gateway timeout
        let contentBuf = "";
        const toolCallBufs = {}; // index → { id, name, argsBuf }

        const stream = await client.chat.completions.create({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...conversationMessages],
          tools: EXPLORATION_TOOLS,
          tool_choice: "auto",
          temperature: 0,
          stream: true,
          extra_body: { enable_thinking: true },
        });

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta || {};
          if (delta.content) contentBuf += delta.content;
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallBufs[idx]) {
                toolCallBufs[idx] = { id: tc.id || "", name: tc.function?.name || "", argsBuf: "" };
              }
              if (tc.id) toolCallBufs[idx].id = tc.id;
              if (tc.function?.name) toolCallBufs[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallBufs[idx].argsBuf += tc.function.arguments;
            }
          }
        }

        const toolCalls = Object.values(toolCallBufs).map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argsBuf },
        }));

        assistantMsg = {
          role: "assistant",
          content: contentBuf || null,
          tool_calls: toolCalls.length ? toolCalls : undefined,
        };
      } else {
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...conversationMessages],
          tools: EXPLORATION_TOOLS,
          tool_choice: "auto",
          temperature: 0,
          max_tokens: 1500,
        });
        assistantMsg = response.choices?.[0]?.message;
      }
    } catch (err) {
      console.error("[AgenticExplore] LLM error:", String(err.message || err).slice(0, 200));
      break;
    }

    if (!assistantMsg) break;

    conversationMessages.push(assistantMsg);

    // Model chose not to call a tool — treat as implicit "ready"
    if (!assistantMsg.tool_calls?.length) {
      console.log("[AgenticExplore] No tool calls returned — stopping loop");
      break;
    }

    // Execute every tool call in this turn, collect results
    const toolResults = [];
    let hitReady = false;

    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}

      console.log(`[AgenticExplore] → ${toolName}(${JSON.stringify(args).slice(0, 120)})`);

      if (toolName === "ready_to_plan") {
        readySignal = {
          summary: String(args.summary || ""),
          priorityFiles: Array.isArray(args.priority_files) ? args.priority_files : [],
          rootCause: String(args.root_cause || args.summary || ""),
        };
        hitReady = true;

        emit?.({
          type: "progress",
          stage: "explored",
          message: `✅ Context gathered — ${readySignal.summary.slice(0, 100)}`,
        });

        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ success: true, message: "Proceeding to planning." }),
        });
        continue;
      }

      const result = await executeTool(toolName, args, root);

      // Cache files the model reads so we can pass them to plan_changes.
      // Never let a partial (start_line/end_line) read overwrite a longer read —
      // the planner needs the full file, not a tail chunk.
      if (toolName === "read_file" && result.success && result.content) {
        const relPath = String(args.path || "").trim();
        const existing = loadedFiles.get(relPath);
        if (!existing || result.content.length > existing.content.length) {
          loadedFiles.set(relPath, {
            path: relPath,
            content: result.content,
            size: result.content.length,
            score: 100,
          });
        }
      }

      // SSE progress for the UI
      if (toolName === "grep_code") {
        emit?.({ type: "progress", stage: "exploring", message: `🔍 grep "${args.query}" → ${result.count ?? 0} match(es)` });
      } else if (toolName === "read_file") {
        emit?.({ type: "progress", stage: "exploring", message: `📖 read ${args.path}` });
      } else if (toolName === "list_files") {
        emit?.({ type: "progress", stage: "exploring", message: `📂 ls ${args.dir || "."}` });
      }

      // Cap tool output so we don't blow up the context window
      const raw = JSON.stringify(result);
      const capped = raw.length > MAX_TOOL_OUTPUT_CHARS
        ? raw.slice(0, MAX_TOOL_OUTPUT_CHARS) + '..."[truncated]"}'
        : raw;

      toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: capped });
    }

    conversationMessages.push(...toolResults);

    if (hitReady) break;
  }

  // ── Build fileContext for plan_changes ────────────────────────────────────

  const fileContextMap = new Map();

  // Carry over any context from a previous retry
  for (const f of (existingContext || [])) {
    if (f?.path) fileContextMap.set(f.path, f);
  }

  // Add everything the model read this turn
  for (const [p, f] of loadedFiles) {
    fileContextMap.set(p, { ...f, score: 150 });
  }

  // Eagerly load priority files listed in ready_to_plan that weren't read yet
  if (readySignal?.priorityFiles?.length) {
    for (const relPath of readySignal.priorityFiles.slice(0, 8)) {
      if (fileContextMap.has(relPath)) continue;
      const absPath = path.resolve(root, relPath);
      const content = await readFileSafe(absPath);
      if (content) {
        fileContextMap.set(relPath, { path: relPath, content, size: content.length, score: 200 });
      }
    }
  }

  const fileContext = [...fileContextMap.values()];

  // ── Summarise into investigation shape expected by plan_changes ───────────

  const investigation = {
    likelyRootCause:
      readySignal?.rootCause ||
      readySignal?.summary ||
      `Explored ${loadedFiles.size} file(s) for: ${cleanMessage.slice(0, 100)}`,
    priorityFiles:
      readySignal?.priorityFiles?.length
        ? readySignal.priorityFiles
        : [...loadedFiles.keys()].slice(0, 5),
    evidence: [
      `Agentic loop: ${iteration} iteration(s), ${loadedFiles.size} file(s) read`,
      ...(readySignal ? [`Model signal: ${readySignal.summary.slice(0, 120)}`] : []),
    ],
    confidence: readySignal ? 0.9 : 0.65,
  };

  console.log(
    `[AgenticExplore] Done: ${iteration} iter, ${loadedFiles.size} files read, ${fileContext.length} in context`
  );

  emit?.({ type: "investigation", investigation });

  return {
    fileContext,
    investigation,
    messages: [
      new AIMessage(
        `Exploration: ${iteration} step(s), ${loadedFiles.size} file(s) read.\n` +
        `Focus: ${investigation.likelyRootCause}`
      ),
    ],
  };
}
