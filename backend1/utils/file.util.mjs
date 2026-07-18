/**
 * utils/file.util.mjs
 * Self-contained file helpers (previously depended on the deleted root tools/).
 * Used by attachments.service and response.service.
 */

import path from "path";
import fsSync from "fs";
import { promises as fs } from "fs";
import { PROJECT_ROOT } from "../config/openai.mjs";
import {
  buildResolvedPathCandidates,
  normalizePath,
} from "./path.util.mjs";
import { extractCandidateFilePaths, uniq } from "./text.util.mjs";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo",
  ".cache", "out", ".agent-history", ".kodo", "uploads", "temp_audio",
  ".claude", ".vscode", ".idea",
]);

async function walkFiles(rootAbs, maxDepth = 8, depth = 0, relBase = "") {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = await fs.readdir(rootAbs, { withFileTypes: true }); }
  catch { return []; }

  const out = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ path: rel, is_dir: true });
      out.push(...await walkFiles(path.join(rootAbs, e.name), maxDepth, depth + 1, rel));
    } else {
      out.push({ path: rel, is_dir: false });
    }
  }
  return out;
}

export async function readFileContent(relPath, maxBytes = 200000) {
  try {
    const normalized = normalizePath(relPath);
    const abs = path.resolve(PROJECT_ROOT, normalized);
    if (!abs.startsWith(path.resolve(PROJECT_ROOT))) return "";
    if (!fsSync.existsSync(abs)) return "";
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return "";
    if (stat.size > maxBytes) {
      const fd = await fs.open(abs, "r");
      const buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, 0);
      await fd.close();
      return buf.toString("utf-8");
    }
    return await fs.readFile(abs, "utf-8");
  } catch {
    return "";
  }
}

export function stripToPreview(content, maxChars = 1800) {
  const text = String(content || "").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

export async function findFilesByName(filename, { dir = "", limit = 10 } = {}) {
  const target = String(filename || "").trim().toLowerCase();
  if (!target) return [];
  const baseName = path.basename(target);

  const rootAbs = dir ? path.resolve(PROJECT_ROOT, dir) : PROJECT_ROOT;
  let files;
  try { files = await walkFiles(rootAbs, 8, 0, dir || ""); }
  catch { return []; }

  const scored = files
    .filter((item) => !item.is_dir)
    .map((item) => {
      const filePath = String(item.path || "");
      const name = path.basename(filePath).toLowerCase();
      const exact = name === baseName ? 100 : 0;
      const ends = name.endsWith(baseName) ? 80 : 0;
      const includes = name.includes(baseName) ? 60 : 0;
      const areaBonus = /(?:^|\/)(app|src|components?)\//.test(filePath) ? 5 : 0;
      return {
        path: filePath.replace(/\\/g, "/"),
        score: exact || ends || includes ? (exact || ends || includes) + areaBonus : 0,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return uniq(scored.map((x) => x.path));
}

export async function readExactReferencedFiles(userMessage) {
  const candidatePaths = extractCandidateFilePaths(userMessage);
  if (!candidatePaths.length) return [];

  const snippets = [];
  const seen = new Set();

  for (const candidate of candidatePaths) {
    const resolvedCandidates = buildResolvedPathCandidates(candidate, PROJECT_ROOT);
    for (const absPath of resolvedCandidates) {
      const relPath = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, "/");
      if (seen.has(relPath)) continue;
      if (!fsSync.existsSync(absPath)) continue;
      let stat;
      try { stat = fsSync.statSync(absPath); } catch { continue; }
      if (!stat.isFile()) continue;

      const content = await readFileContent(relPath);
      if (!content) continue;

      snippets.push({ path: relPath, content: content.slice(0, 3000) });
      seen.add(relPath);
      if (snippets.length >= 8) return snippets;
    }
  }
  return snippets;
}

function buildInspectionHints(message) {
  const msg = String(message || "").toLowerCase();
  const hints = [];

  hints.push(...extractCandidateFilePaths(message));

  const folderMatch = msg.match(/\b([a-z0-9._-]+)\s+(folder|directory)\b/i);
  if (folderMatch?.[1]) hints.push(folderMatch[1]);

  if (msg.includes("page")) hints.push("page.tsx", "page.jsx");
  if (msg.includes("layout")) hints.push("layout.tsx", "layout.jsx");
  if (msg.includes("globals")) hints.push("globals.css", "globals.scss");
  if (msg.includes("sidebar")) hints.push("sidebar.tsx", "Sidebar.tsx");
  if (msg.includes("header")) hints.push("header.tsx", "Header.tsx");
  if (msg.includes("navbar")) hints.push("Navbar.tsx", "NavBar.tsx", "navbar.tsx");
  if (msg.includes("form")) hints.push("Form.tsx", "form.tsx");
  if (msg.includes("button")) hints.push("Button.tsx", "button.tsx");
  if (msg.includes("modal")) hints.push("Modal.tsx", "modal.tsx");

  return uniq(hints.map((h) => String(h || "").trim()).filter(Boolean));
}

export async function collectInspectionTargets(message, attachments = []) {
  const hints = buildInspectionHints(message);
  for (const item of attachments) {
    hints.push(item.path, item.originalName, path.basename(item.path));
  }

  const found = [];
  const seen = new Set();

  for (const hint of uniq(hints)) {
    const matches = await findFilesByName(hint, { dir: "", limit: 8 });
    for (const file of matches) {
      if (seen.has(file)) continue;
      seen.add(file);
      found.push(file);
      if (found.length >= 12) return found;
    }
  }
  return found;
}
