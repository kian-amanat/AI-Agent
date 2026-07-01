/**
 * grep_workspace.mjs
 * Searches the project for symbols / patterns extracted from the user message or
 * error trace, then appends matching snippets to fileContext so the planner has
 * precise line-level evidence instead of full-file guesses.
 */

import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
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
]);

async function grepFiles(root, patterns, maxFileHits = 15, contextLines = 2) {
  const hits = [];

  async function walk(dir) {
    if (hits.length >= maxFileHits) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (hits.length >= maxFileHits) return;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }

      if (!CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      let text;
      try {
        text = await fs.readFile(abs, "utf-8");
      } catch {
        continue;
      }

      const lines = text.split("\n");
      const fileMatches = [];

      for (let i = 0; i < lines.length; i++) {
        if (patterns.some((p) => p.test(lines[i]))) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);

          fileMatches.push({
            lineNo: i + 1,
            snippet: lines
              .slice(start, end + 1)
              .map((l, idx) => `${String(start + idx + 1).padStart(4)} | ${l}`)
              .join("\n"),
          });

          i = end;
        }
      }

      if (fileMatches.length) {
        hits.push({ path: path.relative(root, abs).replaceAll("\\", "/"), matches: fileMatches });
      }
    }
  }

  await walk(root);
  return hits;
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function extractSearchTerms(userMessage, investigation, stackTraceSymbols, symbolMatches) {
  const terms = new Set();
  const msg = String(userMessage || "").split(/conversation memory:/i)[0];

  const identifierRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]{3,})\b/g;
  let m;
  while ((m = identifierRe.exec(msg)) !== null) {
    const id = m[1];
    if (
      /^(error|true|false|null|undefined|const|function|return|import|export|async|await|from|this|class|new|type|interface|string|number|boolean|object|void|any)$/i.test(
        id
      )
    ) {
      continue;
    }
    terms.add(id);
  }

  for (const s of stackTraceSymbols || []) terms.add(s);
  for (const item of symbolMatches || []) {
    if (item?.path) {
      const base = path.basename(item.path, path.extname(item.path));
      if (base.length > 3) terms.add(base);
    }
  }

  if (Array.isArray(investigation?.priorityFiles)) {
    for (const f of investigation.priorityFiles) {
      const base = path.basename(f, path.extname(f));
      if (base.length > 3) terms.add(base);
    }
  }

  return unique([...terms])
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
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

export async function grepWorkspaceNode(state) {
  const {
    workspacePath,
    userMessage,
    investigation,
    emit,
    fileContext = [],
    stackTraceSymbols = [],
    symbolMatches = [],
  } = state;

  const root = workspacePath || PROJECT_ROOT;
  const terms = extractSearchTerms(userMessage, investigation, stackTraceSymbols, symbolMatches);

  if (terms.length === 0) {
    return {
      messages: [new AIMessage("Grep: no search terms found.")],
    };
  }

  emit?.({
    type: "progress",
    stage: "grep",
    message: `🔍 Grepping for: ${terms.slice(0, 4).join(", ")}…`,
  });

  const patterns = terms.map((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
  const hits = await grepFiles(root, patterns, 15, 2);

  if (hits.length === 0) {
    emit?.({ type: "progress", stage: "grep_done", message: "🔍 Grep: no new matches." });
    return {
      grepResults: [],
      messages: [new AIMessage("Grep: 0 hits.")],
    };
  }

  const existingPaths = new Set((fileContext || []).map((f) => f.path));
  const newContext = [];

  for (const h of hits) {
    if (existingPaths.has(h.path)) continue;

    newContext.push({
      path: h.path,
      content: h.matches.map((m) => m.snippet).join("\n\n---\n\n"),
      summary: `Grep hit (${h.matches.length} match${h.matches.length > 1 ? "es" : ""}) for: ${terms.join(", ")}`,
      score: 90,
    });
  }

  const mergedContext = mergeContext(fileContext, newContext);

  emit?.({
    type: "progress",
    stage: "grep_done",
    message: `🔍 Grep found ${hits.length} file(s) — ${newContext.length} new added to context.`,
  });

  console.log(`[Grep] ${hits.length} hit(s): ${hits.map((h) => h.path).join(", ")}`);

  return {
    fileContext: mergedContext,
    grepResults: hits,
    locatedFiles: hits.map((h) => ({
      path: h.path,
      score: 95,
    })),
    messages: [
      new AIMessage(
        `Grep results (${hits.length} file${hits.length !== 1 ? "s" : ""}):\n` +
          hits
            .map(
              (h) =>
                `  • ${h.path} (${h.matches.length} match${h.matches.length > 1 ? "es" : ""})`
            )
            .join("\n")
      ),
    ],
  };
}