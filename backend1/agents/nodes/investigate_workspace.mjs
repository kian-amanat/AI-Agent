/**
 * investigate_workspace.mjs
 * Debug-first retrieval node.
 * Goal: collect evidence, identify likely root cause, and prepare focused context
 * for the planner. This is the "Claude Code / Cursor style" investigation step.
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
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "out",
  ".vscode",
  "uploads",
  ".agent-history",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".html",
  ".xml",
  ".env",
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

function isBadRequestBug(message) {
  return /bad request|400|fstd_err_ctp_empty_json_body|body cannot be empty|invalid json|request body|content-type/i.test(
    String(message || "")
  );
}

function isSessionDeleteBug(message) {
  return /delete session|sessions\/|\/sessions|remove session|session delete/i.test(
    String(message || "")
  );
}

function buildPriorityHints(message, scoredFiles) {
  const lower = String(message || "").toLowerCase();
  const hints = [];

  const pushIfExists = (patterns) => {
    const match = scoredFiles.find((f) => patterns.some((p) => p.test(f.path)));
    if (match && !hints.includes(match.path)) hints.push(match.path);
  };

  if (isBadRequestBug(lower)) {
    pushIfExists([/app\/lib\/api\.ts$/i, /lib\/api\.ts$/i, /api\.ts$/i]);

    pushIfExists([/routes?\/.*session/i, /route\.ts$/i, /route\.mjs$/i, /route\.js$/i]);

    pushIfExists([/services?\/.*session/i, /session\.service\.(mjs|js|ts)$/i]);

    pushIfExists([/server\.mjs$/i, /server\.js$/i, /fastify/i, /app\.mjs$/i]);
  }

  if (isSessionDeleteBug(lower)) {
    pushIfExists([/app\/lib\/api\.ts$/i, /lib\/api\.ts$/i]);

    pushIfExists([/session\.service\.(mjs|js|ts)$/i, /services?\/.*session/i]);

    pushIfExists([/routes?\/.*session/i, /route\.(ts|js|mjs)$/i]);
  }

  return hints;
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

function scoreRelevance(filePath, userMessage, rememberedTargetFile = "") {
  const msg = String(userMessage || "").toLowerCase();
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

  if (/bad request|400|fstd_err_ctp_empty_json_body|body cannot be empty/i.test(msg)) {
    if (/app\/lib\/api\.ts$|lib\/api\.ts$|api\.ts$/i.test(fp)) score += 200;
    if (/route\.ts$|route\.js$|route\.mjs$/i.test(fp)) score += 120;
    if (/session\.service\.(mjs|js|ts)$/i.test(fp)) score += 110;
    if (/server\.mjs$|server\.js$|fastify|app\.mjs$/i.test(fp)) score += 90;
    if (/request|fetch|api|sessions|session/i.test(fp)) score += 60;
  }

  if (/delete session|\/sessions|sessions\//i.test(msg)) {
    if (/app\/lib\/api\.ts$|lib\/api\.ts$|api\.ts$/i.test(fp)) score += 150;
    if (/session\.service\.(mjs|js|ts)$/i.test(fp)) score += 120;
    if (/route\.ts$|route\.js$|route\.mjs$/i.test(fp)) score += 100;
    if (/server\.mjs$|server\.js$|fastify|app\.mjs$/i.test(fp)) score += 80;
  }

  return score;
}

function collectImportHints(content) {
  const hints = new Set();
  const text = String(content || "");

  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(text)) !== null) {
    const spec = match[1];
    if (spec.startsWith(".")) hints.add(spec);
  }

  return [...hints];
}

function resolveImportHint(baseFilePath, hint) {
  if (!hint.startsWith(".")) return [];
  const baseDir = path.dirname(baseFilePath);
  const raw = path.resolve(baseDir, hint);

  return [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.mjs`,
    `${raw}.cjs`,
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
    path.join(raw, "index.js"),
    path.join(raw, "index.jsx"),
  ];
}

function buildEvidenceSummary({ message, errorFiles, namedFile, allFiles, scored }) {
  const top = scored.slice(0, 8).map((f) => ({
    path: f.path,
    score: f.score,
  }));

  return {
    message,
    errorFiles,
    namedFile,
    topCandidates: top,
    fileCount: allFiles.length,
  };
}

async function askForInvestigationPlan({ modelRoute, userMessage, evidence, loadedFiles }) {
  try {
    const prompt = `You are a senior debugging agent.

Your job:
1. Identify the likely root cause of the bug.
2. Explain why the frontend error is happening.
3. Identify which files are the most important to inspect/edit.
4. Return JSON only.

Observed bug:
${JSON.stringify(evidence, null, 2)}

Loaded files:
${loadedFiles.map((f) => `- ${f.path}`).join("\n")}

User message:
${userMessage}

Return JSON:
{
  "issueType": "http_request | routing | ui_state | validation | typing | rendering | unknown",
  "likelyRootCause": "one sentence",
  "confidence": 0.0,
  "evidence": ["..."],
  "hypotheses": ["..."],
  "priorityFiles": ["relative/path", "..."],
  "nextChecks": ["..."]
}`;

    const res = await callLLM({
      system: "You are a precise debugging analyst. Return JSON only.",
      messages: [{ role: "user", content: prompt }],
      modelRoute,
      maxTokens: 900,
      temperature: 0,
    });

    const raw = String(res?.content || "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return null;

    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function mergeContext(existing = [], added = []) {
  const map = new Map();
  for (const item of existing || []) {
    if (item?.path) map.set(item.path, item);
  }
  for (const item of added || []) {
    if (item?.path) map.set(item.path, item);
  }
  return [...map.values()];
}

export async function investigateWorkspaceNode(state) {
  const {
    workspacePath,
    userMessage,
    modelRoute,
    emit,
    rememberedTargetFile = "",
  } = state;

  emit?.({ type: "progress", stage: "investigating", message: "🧠 Investigating bug..." });

  const root = workspacePath || PROJECT_ROOT;
  const cleanMessage = String(userMessage).split(/conversation memory:/i)[0].trim();

  const allFiles = await walkWorkspace(root, 6);
  const codeFiles = allFiles.filter((f) => !f.is_dir);

  const errorFiles = extractFilesFromError(cleanMessage);
  const namedFile = extractNamedFile(cleanMessage);

  const scored = codeFiles
    .map((f) => ({ ...f, score: scoreRelevance(f.path, cleanMessage, rememberedTargetFile) }))
    .sort((a, b) => b.score - a.score);

  const priorityHints = buildPriorityHints(cleanMessage, scored);

  let toRead = [];

  for (const hint of priorityHints) {
    const match = scored.find((f) => f.path === hint);
    if (match && !toRead.find((r) => r.path === match.path)) {
      toRead.push(match);
    }
  }

  for (const ef of errorFiles) {
    const match = scored.find(
      (f) =>
        f.path.endsWith(ef) ||
        f.name === path.basename(ef) ||
        f.path.toLowerCase().includes(ef.toLowerCase())
    );
    if (match && !toRead.find((r) => r.path === match.path)) toRead.push(match);
  }

  if (namedFile) {
    const namedMatch = scored.find(
      (f) =>
        f.path.toLowerCase().endsWith(namedFile.toLowerCase()) ||
        f.name.toLowerCase() === namedFile.toLowerCase()
    );
    if (namedMatch && !toRead.find((r) => r.path === namedMatch.path)) toRead.push(namedMatch);
  }

  const lower = cleanMessage.toLowerCase();
  if (lower.includes("session") || lower.includes("/sessions")) {
    const sessionCandidates = scored.filter(
      (f) =>
        /session/i.test(f.path) ||
        /api\/|routes?\/|service/i.test(f.path) ||
        /page\.tsx?$|layout\.tsx?$|lib\/api/i.test(f.path)
    );
    for (const c of sessionCandidates.slice(0, 6)) {
      if (!toRead.find((r) => r.path === c.path)) toRead.push(c);
    }
  }

  for (const c of scored.slice(0, 6)) {
    if (!toRead.find((r) => r.path === c.path)) toRead.push(c);
  }

  emit?.({
    type: "progress",
    stage: "reading",
    message: `📖 Reading ${toRead.length} evidence files...`,
  });

  const fileContext = [];
  const seen = new Set();

  for (const file of toRead.slice(0, 12)) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);

    const absPath = path.join(root, file.path);
    const content = await readFileSafe(absPath, 60_000);
    if (content === null) continue;

    fileContext.push({
      path: file.path,
      content,
      size: content.length,
      score: file.score,
    });
  }

  const extraCandidates = [];
  const existingPaths = new Set(fileContext.map((f) => f.path));

  for (const loaded of fileContext.slice(0, 4)) {
    const hints = collectImportHints(loaded.content);
    for (const hint of hints) {
      const candidates = resolveImportHint(loaded.path, hint);
      for (const c of candidates) {
        const rel = path.relative(root, c);
        if (!rel || rel.startsWith("..") || existingPaths.has(rel)) continue;
        const found = scored.find((f) => f.path === rel);
        if (found) extraCandidates.push(found);
      }
    }
  }

  for (const extra of extraCandidates.slice(0, 4)) {
    const absPath = path.join(root, extra.path);
    const content = await readFileSafe(absPath, 60_000);
    if (content === null) continue;

    existingPaths.add(extra.path);
    fileContext.push({
      path: extra.path,
      content,
      size: content.length,
      score: extra.score + 10,
    });
  }

  const evidence = buildEvidenceSummary({
    message: cleanMessage,
    errorFiles,
    namedFile,
    allFiles,
    scored,
  });

  const aiInvestigation = await askForInvestigationPlan({
    modelRoute,
    userMessage: cleanMessage,
    evidence,
    loadedFiles: fileContext,
  });

  const fallbackInvestigation = {
    issueType: "unknown",
    likelyRootCause:
      errorFiles.length > 0
        ? `The bug appears to involve ${errorFiles.join(", ")} and likely comes from a request/validation mismatch or a wrong API contract.`
        : "The bug likely comes from a frontend/backend contract mismatch or a missing validation rule.",
    confidence: 0.55,
    evidence: [
      ...errorFiles.map((f) => `Stack trace references: ${f}`),
      namedFile ? `User named file: ${namedFile}` : null,
    ].filter(Boolean),
    hypotheses: [
      "Frontend is sending a request in a shape the backend does not accept.",
      "The route is rejecting the request before handler logic runs.",
      "The client helper may be forcing JSON headers without a body.",
    ],
    priorityFiles: fileContext.slice(0, 5).map((f) => f.path),
    nextChecks: [
      "Inspect the actual fetch/request helper.",
      "Inspect the backend route signature and body parsing expectations.",
      "Compare client headers/body with the server's accepted contract.",
    ],
  };

  const investigation = aiInvestigation || fallbackInvestigation;

  investigation.priorityFiles = [
    ...priorityHints,
    ...(investigation.priorityFiles || []),
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  emit?.({
    type: "progress",
    stage: "investigated",
    message: `✅ Investigation complete. Likely root cause: ${investigation.likelyRootCause || fallbackInvestigation.likelyRootCause}`,
  });

  emit?.({
    type: "investigation",
    investigation,
  });

  return {
    fileContext,
    investigation,
    messages: [
      new AIMessage(
        `Investigation complete.\nRoot cause: ${
          investigation.likelyRootCause || fallbackInvestigation.likelyRootCause
        }`
      ),
    ],
  };
}

export const exploreWorkspaceNode = investigateWorkspaceNode;