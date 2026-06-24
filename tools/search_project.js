import { execSync } from "child_process";
import path from "path";
import fs from "fs";

const PROJECT_ROOT = process.env.WORKSPACE_PATH || process.cwd();

// Files/dirs to always skip
const IGNORE_DIRS = [
  "node_modules", ".git", ".next", "dist", "build",
  ".cache", "coverage", "__pycache__", ".turbo",
  "uploads", "temp_audio", ".agent-history",
];

const IGNORE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".wav", ".webm",
  ".zip", ".tar", ".gz",
  ".lock", ".log",
];

/**
 * Search for text pattern across project files.
 * Uses grep (available on macOS/Linux) for speed.
 * Returns matching lines with file paths.
 */
export function grepSearch(pattern, { maxResults = 30, caseSensitive = false, dir = "" } = {}) {
  if (!pattern || typeof pattern !== "string") return [];

  const searchDir = dir ? path.resolve(PROJECT_ROOT, dir) : PROJECT_ROOT;
  if (!fs.existsSync(searchDir)) return [];

  const excludeDirs = IGNORE_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
  const includes = [
    "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx",
    "--include=*.mjs", "--include=*.cjs", "--include=*.css", "--include=*.scss",
    "--include=*.json", "--include=*.md", "--include=*.html",
  ].join(" ");
  const flags = caseSensitive ? "-rn" : "-rin";
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const cmd = `grep ${flags} ${includes} ${excludeDirs} -l "${escaped}" "${searchDir}" 2>/dev/null | head -${maxResults}`;

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 512 });
    return output.trim().split("\n").filter(Boolean).map((absPath) =>
      path.relative(PROJECT_ROOT, absPath).replace(/\\/g, "/")
    );
  } catch {
    return [];
  }
}

/**
 * Search with context — returns matching lines with surrounding context.
 */
export function grepSearchWithContext(pattern, { maxResults = 20, contextLines = 2, caseSensitive = false, dir = "" } = {}) {
  if (!pattern || typeof pattern !== "string") return [];

  const searchDir = dir ? path.resolve(PROJECT_ROOT, dir) : PROJECT_ROOT;
  if (!fs.existsSync(searchDir)) return [];

  const excludeDirs = IGNORE_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
  const includes = [
    "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx",
    "--include=*.mjs", "--include=*.cjs", "--include=*.css", "--include=*.scss",
    "--include=*.json", "--include=*.md", "--include=*.html",
  ].join(" ");
  const flags = caseSensitive ? "-rn" : "-rin";
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const cmd = `grep ${flags} -C ${contextLines} ${includes} ${excludeDirs} "${escaped}" "${searchDir}" 2>/dev/null | head -${maxResults * (contextLines * 2 + 3)}`;

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 512 });
    return parseGrepOutput(output);
  } catch {
    return [];
  }
}

/**
 * Parse grep -C output into structured results.
 */
function parseGrepOutput(output) {
  const results = [];
  const blocks = output.split("--\n");

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (!lines.length) continue;

    let file = null;
    const matchLines = [];

    for (const line of lines) {
      // Format: filepath:lineNumber:content or filepath-lineNumber-content
      const match = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
      if (match) {
        const [, filePath, lineNum, content] = match;
        const relPath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, "/");
        if (!file) file = relPath;
        matchLines.push({ line: parseInt(lineNum), content: content.trimEnd() });
      }
    }

    if (file && matchLines.length) {
      results.push({ file, matches: matchLines });
    }
  }

  return results;
}

/**
 * Find files by name pattern (fuzzy).
 */
export function findFiles(namePattern, { maxResults = 15, dir = "" } = {}) {
  if (!namePattern) return [];

  const searchDir = dir ? path.resolve(PROJECT_ROOT, dir) : PROJECT_ROOT;
  if (!fs.existsSync(searchDir)) return [];

  const excludes = IGNORE_DIRS.map((d) => `-not -path "*/${d}/*"`).join(" ");
  const escaped = namePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const cmd = `find "${searchDir}" -type f -iname "*${escaped}*" ${excludes} 2>/dev/null | head -${maxResults}`;

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 });
    return output.trim().split("\n").filter(Boolean).map((absPath) =>
      path.relative(PROJECT_ROOT, absPath).replace(/\\/g, "/")
    );
  } catch {
    return [];
  }
}

/**
 * Smart search — detects what kind of search is needed from user message.
 * Returns enriched context string ready to inject into LLM prompt.
 */
export function smartSearch(userMessage) {
  const msg = String(userMessage || "");
  const results = { files: [], usages: [], definitions: [] };

  // 1. Extract file references and find them
  const fileRefs = extractSearchableTerms(msg);

  for (const term of fileRefs.filenames) {
    const found = findFiles(term, { maxResults: 5 });
    results.files.push(...found);
  }

  // 2. Search for component/function/variable names
  for (const term of fileRefs.identifiers) {
    // Find where it's defined
    const defs = grepSearch(`(function|const|class|export|interface|type)\\s+${term}`, { maxResults: 5 });
    results.definitions.push(...defs.map((f) => ({ file: f, term, type: "definition" })));

    // Find where it's used/imported
    const usages = grepSearch(term, { maxResults: 10 });
    results.usages.push(...usages.map((f) => ({ file: f, term, type: "usage" })));
  }

  // 3. Search for keywords mentioned in the message
  for (const keyword of fileRefs.keywords) {
    const found = grepSearch(keyword, { maxResults: 5 });
    results.usages.push(...found.map((f) => ({ file: f, term: keyword, type: "keyword" })));
  }

  return formatSearchResults(results);
}

/**
 * Extract searchable terms from user message.
 */
function extractSearchableTerms(message) {
  const msg = String(message || "");

  // File patterns: anything.tsx, something.css etc
  const filenameRegex = /\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|mjs|json|html|md)\b/g;
  const filenames = [...new Set((msg.match(filenameRegex) || []))];

  // PascalCase identifiers (component names): ChatHeader, LoginForm etc
  const pascalRegex = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;
  const pascalMatches = [...new Set((msg.match(pascalRegex) || []))];

  // camelCase identifiers: handleSubmit, fetchData etc
  const camelRegex = /\b([a-z][a-zA-Z0-9]{4,})\b/g;
  const camelMatches = [...new Set((msg.match(camelRegex) || []))]
    .filter((m) => !["please", "change", "modify", "update", "remove", "create", "should", "could", "would", "instead", "whole", "every", "where", "which", "public", "private"].includes(m));

  // Keywords from message (nouns that might be component/feature names)
  const keywords = msg
    .toLowerCase()
    .split(/[\s,.:;!?()[\]{}'"]+/)
    .filter((w) => w.length > 3)
.filter((w) => !["this", "that", "with", "from", "have", "want",
  "like", "make", "please", "should", "could", "would", "just",
  "also", "then", "when", "what", "your", "they", "them", "been",
  "some", "into", "more", "very", "each", "will", "about",
  "replace", "change", "update", "remove", "delete", "modify",
  "create", "build", "install", "move", "copy", "rename",
  "instead", "whole", "every", "where", "which", "public",
  "private", "using", "used", "find", "show", "list",
  "keep", "need", "want", "logo", "icon", "file", "folder",
].includes(w))    .slice(0, 8);

  return {
    filenames,
    identifiers: [...new Set([...pascalMatches, ...camelMatches])].slice(0, 10),
    keywords: [...new Set(keywords)].slice(0, 8),
  };
}

/**
 * Format search results into context string for LLM.
 */
function formatSearchResults(results) {
  const lines = [];
  const allFiles = new Set();

  if (results.files.length) {
    lines.push("=== Search: File matches ===");
    for (const f of [...new Set(results.files)].slice(0, 10)) {
      lines.push(`  ${f}`);
      allFiles.add(f);
    }
  }

  if (results.definitions.length) {
    lines.push("\n=== Search: Definitions found ===");
    const seen = new Set();
    for (const d of results.definitions.slice(0, 10)) {
      const key = `${d.file}:${d.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${d.term} → ${d.file}`);
      allFiles.add(d.file);
    }
  }

  if (results.usages.length) {
    lines.push("\n=== Search: Usages found ===");
    const seen = new Set();
    for (const u of results.usages.slice(0, 15)) {
      const key = `${u.file}:${u.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${u.term} used in → ${u.file}`);
      allFiles.add(u.file);
    }
  }

  return {
    text: lines.join("\n"),
    files: [...allFiles],
  };
}