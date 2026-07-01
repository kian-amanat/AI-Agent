/**
 * explore_workspace.mjs
 * Workspace retrieval node.
 * Scans the project, ranks files, reads the most relevant ones,
 * and expands context using error traces, named files, and related imports.
 */

import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { callLLM } from "../../services/llm.mjs";
import { AIMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build",
  "coverage", ".turbo", ".cache", "out", ".vscode",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".json", ".md", ".yaml", ".yml",
  ".html", ".xml", ".env",
]);

async function safeStat(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readFileSafe(absPath, maxBytes = 80_000) {
  try {
    const stat = await safeStat(absPath);
    if (!stat || !stat.isFile()) return null;

    if (stat.size > maxBytes) {
      const fd = await fs.open(absPath, "r");
      const buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, 0);
      await fd.close();
      return buf.toString("utf-8") + "\n... [truncated]";
    }

    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function walkWorkspace(root, maxDepth = 6, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth) return results;

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;

    const abs = path.join(root, entry.name);
    const rel = path.relative(root, abs);
    const ext = path.extname(entry.name).toLowerCase();

    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: rel, is_dir: true });
      const children = await walkWorkspace(abs, maxDepth, currentDepth + 1);
      results.push(...children.map((c) => ({ ...c, path: path.join(rel, c.path) })));
    } else if (CODE_EXTENSIONS.has(ext)) {
      const stat = await safeStat(abs);
      results.push({
        name: entry.name,
        path: rel,
        is_dir: false,
        size: stat?.size ?? 0,
        ext: ext.replace(".", ""),
      });
    }
  }

  return results;
}

function isErrorReport(message) {
  return /\b(error|bug|fix|crash|broken|failed|exception|stack trace|TypeError|ReferenceError|SyntaxError|Bad Request|404|500|401|503)\b/i.test(message);
}

function extractNamedFile(msg) {
  const extMatch = msg.match(/\b([\w\-./]+\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|yaml|yml|html|xml))\b/i);
  if (extMatch) return extMatch[1];

  const componentMap = {
    chatsidebar: "ChatSidebar.tsx",
    chatheader: "ChatHeader.tsx",
    chatcomposer: "ChatComposer.tsx",
    assistantmessage: "AssistantMessage.tsx",
    thinkingtrace: "ThinkingTrace.tsx",
    agentpipeline: "AgentPipelinePanel.tsx",
    emptystatecard: "EmptyStateCard.tsx",
    typingindicator: "TypingIndicator.tsx",
  };

  const lower = msg.toLowerCase();
  for (const [key, file] of Object.entries(componentMap)) {
    if (lower.includes(key)) return file;
  }

  return null;
}

function extractFilesFromError(message) {
  const files = new Set();

  const patterns = [
    /\b(app\/[^\s:)]+\.[a-z]+)/gi,
    /\bat\s+\S+\s+\(([^)]+\.[a-z]+):\d+/gi,
    /\b([\w\-./]+\.(tsx?|jsx?|mjs|cjs|ts|js))\b:\d+/gi,
    /\b(components?\/[^\s:)]+\.[a-z]+)/gi,
    /\b(services?\/[^\s:)]+\.[a-z]+)/gi,
    /\b(routes?\/[^\s:)]+\.[a-z]+)/gi,
    /\b(hooks?\/[^\s:)]+\.[a-z]+)/gi,
    /\b(lib\/[^\s:)]+\.[a-z]+)/gi,
    /\b(utils?\/[^\s:)]+\.[a-z]+)/gi,
  ];

  for (const p of patterns) {
    let match;
    while ((match = p.exec(message)) !== null) {
      const f = match[1] || match[0];
      const clean = f.replace(/:\d+.*$/, "").trim();
      if (clean && clean.includes(".") && !clean.startsWith("node:")) {
        files.add(clean);
      }
    }
  }

  return [...files];
}

function collectImportHints(content) {
  const hints = new Set();
  const text = String(content || "");

  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(text)) !== null) {
    const spec = match[1];
    if (spec.startsWith(".")) {
      hints.add(spec);
    }
  }

  return [...hints];
}

function resolveImportHint(baseFilePath, hint) {
  if (!hint.startsWith(".")) return null;
  const baseDir = path.dirname(baseFilePath);
  const candidates = [];

  const raw = path.resolve(baseDir, hint);
  candidates.push(raw);
  candidates.push(`${raw}.ts`);
  candidates.push(`${raw}.tsx`);
  candidates.push(`${raw}.js`);
  candidates.push(`${raw}.jsx`);
  candidates.push(`${raw}.mjs`);
  candidates.push(`${raw}.cjs`);
  candidates.push(path.join(raw, "index.ts"));
  candidates.push(path.join(raw, "index.tsx"));
  candidates.push(path.join(raw, "index.js"));
  candidates.push(path.join(raw, "index.jsx"));

  return candidates;
}

function scoreRelevance(filePath, userMessage, rememberedTargetFile = "") {
  const msg = userMessage.toLowerCase();
  const fp = filePath.toLowerCase();
  const base = path.basename(fp);
  let score = 0;

  if (rememberedTargetFile) {
    const remembered = rememberedTargetFile.toLowerCase();
    const remBase = path.basename(remembered);
    if (fp === remembered || fp.endsWith(remembered)) score += 120;
    else if (base === remBase) score += 80;
  }

  if (msg.includes(base)) score += 100;
  fp.split("/").forEach((seg) => {
    if (seg && msg.includes(seg)) score += 18;
  });

  if (fp.endsWith(".tsx") || fp.endsWith(".jsx")) score += 8;
  if (fp.endsWith("page.tsx") || fp.endsWith("page.jsx")) score += 12;
  if (fp.endsWith("layout.tsx") || fp.endsWith("layout.jsx")) score += 10;
  if (fp.endsWith("route.ts") || fp.endsWith("route.js")) score += 10;

  const keywords = [
    ["component", "components"],
    ["route", "routes"],
    ["layout", "layout"],
    ["login", "login"],
    ["auth", "auth"],
    ["api", "api"],
    ["sidebar", "sidebar"],
    ["chat", "chat"],
    ["settings", "settings"],
    ["session", "session"],
    ["delete", "delete"],
    ["undo", "undo"],
    ["pipeline", "pipeline"],
    ["agent", "agent"],
    ["model", "model"],
    ["kodo", "kodo"],
  ];

  for (const [kw, segment] of keywords) {
    if (msg.includes(kw) && fp.includes(segment)) score += 15;
  }

  return score;
}

async function summarizeLargeFile(filePath, content, modelRoute) {
  try {
    if (!modelRoute?.model) return "";
    if (content.length < 3000) return "";

    const res = await callLLM({
      system: "You are a concise code summariser. In 2-3 sentences, describe what this file does and its key exports/components.",
      messages: [{ role: "user", content: `File: ${filePath}\n\n${content.slice(0, 4000)}` }],
      modelRoute,
      maxTokens: 140,
      temperature: 0,
    });

    return res?.content?.trim() || "";
  } catch {
    return "";
  }
}

export async function exploreWorkspaceNode(state) {
  const { workspacePath, userMessage, modelRoute, emit, rememberedTargetFile = "" } = state;

  emit?.({ type: "progress", stage: "exploring", message: "📂 Scanning workspace..." });

  const root = workspacePath || PROJECT_ROOT;
  const cleanMessage = String(userMessage).split(/conversation memory:/i)[0].trim();

  const allFiles = await walkWorkspace(root, 6);
  const codeFiles = allFiles.filter((f) => !f.is_dir);

  emit?.({
    type: "progress",
    stage: "scanning",
    message: `📁 Found ${allFiles.length} entries (${codeFiles.length} files). Ranking relevance...`,
  });

  const scored = codeFiles
    .map((f) => ({ ...f, score: scoreRelevance(f.path, cleanMessage, rememberedTargetFile) }))
    .sort((a, b) => b.score - a.score);

  const namedFile = extractNamedFile(cleanMessage);
  const errorFiles = extractFilesFromError(cleanMessage);
  const hasError = isErrorReport(cleanMessage);

  let toRead = [];

  if (hasError && errorFiles.length > 0) {
    console.log(`[Explore] Bug mode: found ${errorFiles.length} files in error trace: ${errorFiles.join(", ")}`);

    for (const ef of errorFiles) {
      const match = scored.find((f) =>
        f.path.endsWith(ef) ||
        f.name === path.basename(ef) ||
        f.path.toLowerCase().includes(ef.toLowerCase())
      );

      if (match && !toRead.find((r) => r.path === match.path)) {
        toRead.push(match);
      }
    }

    if (namedFile) {
      const namedMatch = scored.find((f) =>
        f.path.toLowerCase().endsWith(namedFile.toLowerCase()) ||
        f.name.toLowerCase() === namedFile.toLowerCase()
      );

      if (namedMatch && !toRead.find((r) => r.path === namedMatch.path)) {
        toRead.push(namedMatch);
      }
    }

    if (cleanMessage.includes("session") || cleanMessage.includes("/sessions")) {
      const sessionRoute = scored.find((f) => f.name === "plannerAgent.mjs" || f.path.includes("routes/"));
      if (sessionRoute && !toRead.find((r) => r.path === sessionRoute.path)) toRead.push(sessionRoute);

      const sessionService = scored.find((f) => f.name === "session.service.mjs");
      if (sessionService && !toRead.find((r) => r.path === sessionService.path)) toRead.push(sessionService);
    }

    emit?.({
      type: "progress",
      stage: "reading",
      message: `🐛 Loading ${toRead.length} files from error trace...`,
    });
  } else if (namedFile) {
    const exact = scored.find((f) =>
      f.path.toLowerCase().endsWith(namedFile.toLowerCase()) ||
      f.name.toLowerCase() === namedFile.toLowerCase()
    );

    if (exact) {
      emit?.({ type: "progress", stage: "reading", message: `📖 Loading ${namedFile}...` });
      toRead = [exact];
    } else {
      toRead = scored.filter((f) => f.score > 0).slice(0, 5);
    }
  } else {
    const CONFIG_FILES = ["package.json", "tsconfig.json", ".env", "README.md"];
    const topScored = scored.filter((f) => f.score > 0).slice(0, 8);
    const configFiles = scored.filter((f) => f.score === 0 && CONFIG_FILES.some((c) => f.name === c)).slice(0, 2);
    toRead = [...topScored, ...configFiles];

    emit?.({
      type: "progress",
      stage: "reading",
      message: `📖 Reading ${toRead.length} relevant files...`,
    });
  }

  const fileContext = [];
  const seen = new Set();

  for (const file of toRead) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);

    const absPath = path.join(root, file.path);
    const content = await readFileSafe(absPath, 60_000);
    if (content === null) continue;

    const summary = await summarizeLargeFile(file.path, content, modelRoute);
    fileContext.push({
      path: file.path,
      content,
      summary,
      size: content.length,
      score: file.score,
    });
  }

  // Expand with related imports from the top few loaded files.
  const additionalCandidates = [];
  const existingPaths = new Set(fileContext.map((f) => f.path));

  for (const loaded of fileContext.slice(0, 4)) {
    const hints = collectImportHints(loaded.content);
    for (const hint of hints) {
      const candidates = resolveImportHint(loaded.path, hint);
      for (const c of candidates) {
        const rel = path.relative(root, c);
        if (!rel || rel.startsWith("..")) continue;
        if (existingPaths.has(rel)) continue;

        const found = scored.find((f) => f.path === rel);
        if (found) additionalCandidates.push(found);
      }
    }
  }

  for (const extra of additionalCandidates.slice(0, 4)) {
    const absPath = path.join(root, extra.path);
    const content = await readFileSafe(absPath, 60_000);
    if (content === null) continue;

    existingPaths.add(extra.path);
    fileContext.push({
      path: extra.path,
      content,
      summary: await summarizeLargeFile(extra.path, content, modelRoute),
      size: content.length,
      score: extra.score + 15,
    });
  }

  emit?.({
    type: "progress",
    stage: "explored",
    message: `✅ Loaded context from ${fileContext.length} files. Planning changes...`,
  });

  emit?.({
    type: "file_context",
    files: fileContext.map((f) => ({ path: f.path, size: f.size, summary: f.summary })),
  });

  return {
    fileContext,
    rememberedTargetFile,
    messages: [
      new AIMessage(
        `Workspace scanned. Loaded ${fileContext.length} relevant files:\n` +
        fileContext.map((f) => `  • ${f.path}${f.summary ? " – " + f.summary : ""}`).join("\n")
      ),
    ],
  };
}