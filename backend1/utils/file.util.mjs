import path from "path";
import fsSync from "fs";
import { readFile as readFileAsync } from "fs/promises";
import { listBackendFiles } from "../../tools/list_backend_files.js";
import { readProjectFile } from "../../tools/readProjectFile.js";
import { PROJECT_ROOT, PLANS_DIR } from "../config/openai.mjs";
import {
  buildResolvedPathCandidates,
  inferLanguageFromPath,
  normalizePath,
} from "./path.util.mjs";
import { extractCandidateFilePaths, uniq } from "./text.util.mjs";

export async function readFileContent(relPath, maxBytes = 200000) {
  try {
    const normalized = normalizePath(relPath);
    const abs = path.resolve(PROJECT_ROOT, normalized);

    if (!fsSync.existsSync(abs)) return "";

    const res = await readProjectFile({
      path: normalized,
      maxBytes,
    });

    if (!res?.success) return "";
    return String(res.content || "");
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

  let res;
  try {
    res = await listBackendFiles({
      dir,
      maxDepth: 12,
      includeFiles: true,
      includeDirs: false,
      includeMeta: true,
    });
  } catch {
    return [];
  }

  if (!res?.success || !Array.isArray(res.files)) return [];

  const scored = res.files
    .filter((item) => !item.is_dir)
    .map((item) => {
      const filePath = String(item.path || "");
      const name = path.basename(filePath).toLowerCase();

      const exact = name === baseName ? 100 : 0;
      const ends = name.endsWith(baseName) ? 80 : 0;
      const includes = name.includes(baseName) ? 60 : 0;
      const areaBonus =
        filePath.includes("frontend/") ||
        filePath.includes("app/") ||
        filePath.includes("src/") ||
        filePath.includes("uploads/")
          ? 5
          : 0;

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
      try {
        stat = fsSync.statSync(absPath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;

      const content = await readFileContent(relPath);
      if (!content) continue;

      snippets.push({
        path: relPath,
        content: content.slice(0, 3000),
      });

      seen.add(relPath);

      if (snippets.length >= 8) return snippets;
    }
  }

  return snippets;
}

export async function collectReferenceSnippets(userMessage) {
  const seen = new Set();
  const snippets = [];

  const hints = uniq([
    "page.tsx",
    "layout.tsx",
    "globals.css",
    "page.jsx",
    "layout.jsx",
    "globals.scss",
    "globals.sass",
    "globals.less",
    ...extractCandidateFilePaths(userMessage),
  ]);

  for (const name of hints) {
    const matches = await findFilesByName(name, { dir: "", limit: 3 });

    for (const relPath of matches) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);

      const content = await readFileContent(relPath);
      if (!content) continue;

      snippets.push({
        path: relPath,
        content: content.slice(0, 3500),
      });

      if (snippets.length >= 8) return snippets;
    }
  }

  return snippets;
}

export async function summarizeProjectStructure(scope) {
  const summary = { backend: "", frontend: "" };

  const collect = async (dirLabel, dirRelPath) => {
    try {
      const res = await listBackendFiles({
        dir: dirRelPath,
        maxDepth: 5,
        includeFiles: true,
        includeDirs: true,
        includeMeta: false,
      });

      if (res?.success && Array.isArray(res.files)) {
        const lines = res.files.map((e) => `${e.is_dir ? "DIR " : "FILE"}: ${e.path}`);
        return lines.length ? lines.join("\n") : `<${dirLabel} dir is empty>`;
      }

      return `<${dirLabel} dir is empty>`;
    } catch (e) {
      return `<error: ${String(e)}>`;
    }
  };

  if (scope === "backend" || scope === "fullstack" || scope === "unknown") {
    summary.backend = await collect("backend", "backend");
  }

  if (scope === "frontend" || scope === "fullstack" || scope === "unknown") {
    summary.frontend = await collect("frontend", "frontend");
  }

  return summary;
}

function buildInspectionHints(message) {
  const msg = String(message || "").toLowerCase();
  const hints = [];

  const explicitFiles = extractCandidateFilePaths(message);
  hints.push(...explicitFiles);

  const folderMatch = msg.match(/\b([a-z0-9._-]+)\s+(folder|directory)\b/i);
  if (folderMatch?.[1]) hints.push(folderMatch[1]);

  if (msg.includes("page")) hints.push("page.tsx", "page.jsx");
  if (msg.includes("layout")) hints.push("layout.tsx", "layout.jsx");
  if (msg.includes("globals")) hints.push("globals.css", "globals.scss");
  if (msg.includes("login")) hints.push("login.tsx", "login/page.tsx", "page.tsx");
  if (msg.includes("sidebar")) hints.push("sidebar.tsx", "Sidebar.tsx");
  if (msg.includes("header")) hints.push("header.tsx", "Header.tsx");
  if (msg.includes("chatbot")) hints.push("chatbot", "my-chatbot-ui", "page.tsx", "routes");
  if (msg.includes("loginform")) hints.push("LoginForm.tsx", "LoginForm.jsx", "LoginForm");
  if (msg.includes("register") || msg.includes("signup")) {
    hints.push(
      "RegisterForm.tsx",
      "SignupForm.tsx",
      "register/page.tsx",
      "signup/page.tsx"
    );
  }
  if (msg.includes("form")) hints.push("Form.tsx", "form.tsx");
  if (msg.includes("button")) hints.push("Button.tsx", "button.tsx");
  if (msg.includes("modal")) hints.push("Modal.tsx", "modal.tsx");
  if (msg.includes("navbar")) hints.push("Navbar.tsx", "NavBar.tsx", "navbar.tsx");
  if (msg.includes("dashboard")) hints.push("dashboard/page.tsx", "Dashboard.tsx");
  if (msg.includes("auth")) hints.push("auth.ts", "auth.tsx", "auth/page.tsx", "[...nextauth]");

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