/**
 * symbol_search.mjs
 * Ranks workspace files by symbol/path relevance using the workspace index,
 * stack trace references, and user request terms.
 */

import path from "path";

function stripConversationMemory(text) {
  return String(text || "").split(/conversation memory:/i)[0].trim();
}

function tokenize(text) {
  return stripConversationMemory(text)
    .replace(/[^a-zA-Z0-9_$./\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function basenameWithoutExt(filePath) {
  const base = path.basename(String(filePath || ""));
  return base.replace(/\.[^.]+$/, "");
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function scoreFile(file, terms, stackTraceFiles, stackTraceSymbols, priorityFiles) {
  const p = String(file.path || "").toLowerCase();
  const base = basenameWithoutExt(file.path).toLowerCase();
  let score = 0;
  const reasons = [];

  for (const term of terms) {
    const t = term.toLowerCase();
    if (!t) continue;

    if (p.includes(t)) {
      score += 10;
      reasons.push(`path:${term}`);
    }

    if (base === t) {
      score += 25;
      reasons.push(`basename:${term}`);
    }

    if (
      p.endsWith(`/${t}.tsx`) ||
      p.endsWith(`/${t}.ts`) ||
      p.endsWith(`/${t}.jsx`) ||
      p.endsWith(`/${t}.js`)
    ) {
      score += 30;
      reasons.push(`exact-file:${term}`);
    }
  }

  for (const f of stackTraceFiles || []) {
    const clean = String(f).replace(/^\.\//, "").toLowerCase();
    if (clean && (p.endsWith(clean) || p.includes(clean))) {
      score += 80;
      reasons.push(`stack-file:${clean}`);
    }
  }

  for (const s of stackTraceSymbols || []) {
    const sym = String(s).toLowerCase();
    if (!sym) continue;
    if (base.includes(sym) || p.includes(sym)) {
      score += 35;
      reasons.push(`symbol:${sym}`);
    }
  }

  for (const f of priorityFiles || []) {
    const clean = String(f).toLowerCase();
    if (clean && (p.endsWith(clean) || p.includes(clean))) {
      score += 60;
      reasons.push(`priority:${clean}`);
    }
  }

  if (p.includes("/api/") || p.endsWith("route.ts") || p.endsWith("route.js") || p.endsWith("route.mjs")) {
    score += 8;
  }
  if (p.includes("/lib/") || p.includes("/services/") || p.includes("/utils/")) {
    score += 5;
  }
  if (p.endsWith(".tsx") || p.endsWith(".jsx")) score += 4;
  if (p.endsWith("page.tsx") || p.endsWith("page.jsx")) score += 10;
  if (p.endsWith("layout.tsx") || p.endsWith("layout.jsx")) score += 8;

  return { score, reasons };
}

export function symbolSearchNode(state) {
  const index = Array.isArray(state.workspaceIndex) ? state.workspaceIndex : [];
  const message = String(state.userMessage || "");
  const terms = unique(tokenize(message)).filter((t) => t.length >= 3).slice(0, 24);

  const stackTraceFiles = Array.isArray(state.stackTraceFiles) ? state.stackTraceFiles : [];
  const stackTraceSymbols = Array.isArray(state.stackTraceSymbols) ? state.stackTraceSymbols : [];
  const priorityFiles = Array.isArray(state.investigation?.priorityFiles)
    ? state.investigation.priorityFiles
    : [];

  const matches = index
    .map((file) => {
      const { score, reasons } = scoreFile(file, terms, stackTraceFiles, stackTraceSymbols, priorityFiles);
      return { ...file, score, reasons };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 18);

  const symbolMatches = matches.map((m) => ({
    path: m.path,
    score: m.score,
    reasons: m.reasons,
  }));

  const locatedFiles = matches.slice(0, 10).map((m) => ({
    path: m.path,
    score: m.score,
  }));

  return {
    symbolMatches,
    locatedFiles,
    messages: [
      ...(state.messages || []),
      {
        role: "system",
        content: `Symbol search ranked ${symbolMatches.length} file(s)`,
      },
    ],
  };
}