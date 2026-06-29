import { AIMessage } from "@langchain/core/messages";
/**
 * explore_workspace.mjs
 * ──────────────────────────────────────────────────────────────
 * Reads the user's project files from the workspace path.
 *
 * Strategy:
 *  1. List top-level structure to understand the project layout
 *  2. Use context_engine to find semantically relevant files
 *  3. Read and summarise each relevant file
 *  4. Build a rich fileContext array for the next node (plan_changes)
 */

import path from "path";
import fs   from "fs/promises";
import { callLLM } from "../../services/llm.mjs";

// ── Helpers ───────────────────────────────────────────────────
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
  try { return await fs.stat(p); } catch { return null; }
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

    const abs  = path.join(root, entry.name);
    const rel  = path.relative(root, abs);
    const ext  = path.extname(entry.name).toLowerCase();

    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: rel, is_dir: true });
      const children = await walkWorkspace(abs, maxDepth, currentDepth + 1);
      results.push(...children.map(c => ({
        ...c,
        path: path.join(rel, c.path),
      })));
    } else if (CODE_EXTENSIONS.has(ext)) {
      const stat = await safeStat(abs);
      results.push({
        name:  entry.name,
        path:  rel,
        is_dir: false,
        size:  stat?.size ?? 0,
        ext:   ext.replace(".", ""),
      });
    }
  }

  return results;
}

async function readFileSafe(absPath, maxBytes = 80_000) {
  try {
    const stat = await safeStat(absPath);
    if (!stat || !stat.isFile()) return null;
    if (stat.size > maxBytes) {
      // Read only the first maxBytes
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

// Score how relevant a file is to the user's message
function scoreRelevance(filePath, userMessage, rememberedTargetFile = "") {
  const msg  = userMessage.toLowerCase();
  const fp   = filePath.toLowerCase();
  const base = path.basename(fp);
  let score  = 0;

  // ★ Remembered target file from a previous turn — strong boost so
  //   "make it bigger" (no filename) still finds the file we just edited.
  if (rememberedTargetFile) {
    const remembered = rememberedTargetFile.toLowerCase();
    const remBase    = path.basename(remembered);
    if (fp === remembered || fp.endsWith(remembered)) score += 90;
    else if (base === remBase) score += 70;
  }

  // Exact filename mention
  if (msg.includes(base)) score += 100;

  // Path segment matches
  fp.split("/").forEach(seg => {
    if (seg && msg.includes(seg)) score += 20;
  });

  // Extension relevance
  if (fp.endsWith(".tsx") || fp.endsWith(".jsx")) score += 5;
  if (fp.endsWith("page.tsx") || fp.endsWith("page.jsx")) score += 10;

  // Keyword matches
  const keywords = [
    ["component", "components"],
    ["route",     "routes"],
    ["layout",    "layout"],
    ["login",     "login"],
    ["auth",      "auth"],
    ["api",       "api"],
    ["sidebar",   "sidebar"],
    ["chat",      "chat"],
    ["settings",  "settings"],
    ["dashboard", "dashboard"],
  ];
  for (const [kw, segment] of keywords) {
    if (msg.includes(kw) && fp.includes(segment)) score += 15;
  }

  return score;
}

// ── Node ──────────────────────────────────────────────────────
export async function exploreWorkspaceNode(state) {
  const { workspacePath, userMessage, modelRoute, emit, rememberedTargetFile = "" } = state;

  emit?.({ type: "progress", stage: "exploring", message: "📂 Scanning workspace..." });

  const root = workspacePath || process.cwd();

  // Strip the "Conversation memory:" suffix so it doesn't skew filename matching,
  // but keep the remembered target file (passed separately) for scoring.
  const cleanMessage = String(userMessage).split(/conversation memory:/i)[0].trim();

  // 1. Walk workspace
  const allFiles = await walkWorkspace(root, 6);
  const codeFiles = allFiles.filter(f => !f.is_dir);

  emit?.({
    type: "progress",
    stage: "scanning",
    message: `📁 Found ${allFiles.length} entries (${codeFiles.length} files). Ranking relevance...`,
  });

  if (rememberedTargetFile) {
    console.log(`[Explore] 🎯 Remembered target file: ${rememberedTargetFile}`);
  }

  // 2. Score & pick top relevant files
  const scored = codeFiles
    .map(f => ({ ...f, score: scoreRelevance(f.path, cleanMessage, rememberedTargetFile) }))
    .sort((a, b) => b.score - a.score);

  // Always read files with score > 0, up to 12 files
  // Plus always include config-ish files if score == 0
  const CONFIG_FILES = ["package.json", "tsconfig.json", ".env", "README.md"];
  const topScored    = scored.filter(f => f.score > 0).slice(0, 12);
  const configFiles  = scored.filter(f =>
    f.score === 0 && CONFIG_FILES.some(c => f.name === c)
  ).slice(0, 3);

  const toRead = [...topScored, ...configFiles];

  emit?.({
    type: "progress",
    stage: "reading",
    message: `📖 Reading ${toRead.length} relevant files...`,
  });

  // 3. Read files
  const fileContext = [];

  for (const file of toRead) {
    const absPath = path.join(root, file.path);
    const content = await readFileSafe(absPath, 60_000);
    if (content === null) continue;

    // Quick LLM summary for large files
    let summary = "";
    if (content.length > 3000 && modelRoute?.model) {
      try {
        const res = await callLLM({
          system: "You are a concise code summariser. In 2-3 sentences, describe what this file does and its key exports/components.",
          messages: [{ role: "user", content: `File: ${file.path}\n\n${content.slice(0, 4000)}` }],
          modelRoute,
          maxTokens: 120,
          temperature: 0,
        });
        summary = res?.content?.trim() || "";
      } catch {
        // summary stays empty — not fatal
      }
    }

    fileContext.push({
      path:    file.path,
      content,
      summary,
      size:    content.length,
      score:   file.score,
    });
  }

  // 4. Build workspace overview (directory tree string)
  const treeLines = [];
  const dirs = allFiles.filter(f => f.is_dir).map(f => f.path).slice(0, 40);
  treeLines.push(`Workspace root: ${root}`);
  treeLines.push(`Total files: ${codeFiles.length}`);
  treeLines.push(`Directories: ${dirs.join(", ")}`);

  emit?.({
    type: "progress",
    stage: "explored",
    message: `✅ Loaded context from ${fileContext.length} files. Planning changes...`,
  });

  // Emit file list to frontend
  emit?.({
    type: "file_context",
    files: fileContext.map(f => ({
      path:    f.path,
      size:    f.size,
      summary: f.summary,
    })),
  });

  return {
    fileContext,
    rememberedTargetFile,   // ★ carry forward so plan_changes receives it
    // Append to messages so plan_changes sees it
    messages: [
      new AIMessage(
        `Workspace scanned. Loaded ${fileContext.length} relevant files:\n` +
        fileContext.map(f => `  • ${f.path}${f.summary ? " – " + f.summary : ""}`).join("\n")
      ),
    ],
  };
}
