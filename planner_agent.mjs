import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import OpenAI from "openai";

import { buildSmartContext } from "./tools/context_engine.js";
import { listBackendFiles } from "./tools/list_backend_files.js";
import { readProjectFile } from "./tools/readProjectFile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- Config ----------
const PROJECT_ROOT = process.cwd();
const BACKEND_ROOT = path.join(PROJECT_ROOT, "backend");
const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");
const BACKEND_CWD_REL = path.relative(PROJECT_ROOT, BACKEND_ROOT) || "backend";
const FRONTEND_CWD_REL = path.relative(PROJECT_ROOT, FRONTEND_ROOT) || "frontend";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD";

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY env var.");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

const DESIGN_REFERENCE_FILENAMES = [
  "page.tsx",
  "layout.tsx",
  "globals.css",
  "page.jsx",
  "layout.jsx",
  "globals.scss",
  "globals.sass",
  "globals.less",
];

// --------- Utils ----------
function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripPathNoise(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[),.;:]+$/g, "");
}

function containsWord(text, word) {
  const regex = new RegExp(`\\b${word}\\b`, "i");
  return regex.test(text);
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function extractLikelyJsonObject(raw) {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return raw.slice(first, last + 1);
}

function inferTaskScopeFromType(taskType) {
  if (taskType.startsWith("frontend_")) return "frontend";
  if (taskType.startsWith("backend_")) return "backend";
  if (taskType === "fullstack_feature") return "fullstack";
  return "unknown";
}

// --------- Intent / request detection ----------
function extractCandidateFilePaths(userMessage) {
  const msg = String(userMessage || "");

  const pathRegex =
    /(?:\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js))/g;

  const filenameRegex =
    /\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js)\b/g;

  const matches = uniq([
    ...(msg.match(pathRegex) || []),
    ...(msg.match(filenameRegex) || []),
  ]);

  return matches.map(stripPathNoise);
}

function hasWorkspaceReference(message) {
  const msg = String(message || "").toLowerCase();

  const fileishWords = [
    "page",
    "layout",
    "globals",
    "sidebar",
    "header",
    "footer",
    "login",
    "component",
    "screen",
    "view",
    "folder",
    "directory",
    "workspace",
    "codebase",
    "repo",
    "project",
    "app",
    "src",
    "ui",
    "design",
    "style",
    "colors",
    "theme",
  ];

  return (
    extractCandidateFilePaths(message).length > 0 ||
    fileishWords.some((w) => msg.includes(w))
  );
}

function isCrisis(message) {
  const lower = message.toLowerCase().replace(/[^a-z\u0600-\u06FF\s]/g, " ");

  const exactKeywords = [
    "suicide",
    "kill myself",
    "end my life",
    "self harm",
    "self-harm",
    "want to die",
    "hurt myself",
    "take my life",
    "خودکشی",
    "بمیرم",
    "خودم رو بکشم",
    "آسیب به خودم",
  ];

  if (exactKeywords.some((k) => lower.includes(k))) return true;

  const fuzzyPatterns = [
    /su[ei]?[ck]?[ie]?[cd]e/i,
    /kill\s*(my\s*self|me)/i,
    /end\s*(my|this)\s*(life|pain)/i,
    /don'?t\s*want\s*to\s*(live|be here)/i,
    /want\s*to\s*(die|disappear)/i,
  ];

  return fuzzyPatterns.some((p) => p.test(lower));
}

const GREETING_PATTERNS = [
  /^(hi|hello|hey|greetings|good morning|good afternoon|good evening)[\s!.?]*$/i,
  /^(thanks|thank you|thx|ty|appreciate it)[\s!.?]*$/i,
  /^(bye|goodbye|see you|cya|take care)[\s!.?]*$/i,
  /^(how are you|what's up|sup|wassup|how's it going|how do you do)[\s!.?]*$/i,
  /^(سلام|درود|صبح بخیر|عصر بخیر|شب بخیر)[\s!.?]*$/i,
  /^(ممنون|متشکرم|مرسی|سپاس)[\s!.?]*$/i,
  /^(خداحافظ|بای|فعلاً)[\s!.?]*$/i,
  /^(حالت چطوره|چطوری|خوبی|چه خبر)[\s!.?]*$/i,
];

function detectLanguage(text) {
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const farsiChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return englishChars > farsiChars ? "en" : "fa";
}

function isGreeting(message) {
  return GREETING_PATTERNS.some((pattern) => pattern.test(message.trim()));
}

function isWorkspaceInspectionRequest(message) {
  const msg = String(message || "").toLowerCase();

  const accessWords = [
    "access",
    "have access",
    "do you have access",
    "can you access",
    "do you access",
    "read",
    "inspect",
    "check",
    "open",
    "show",
    "look at",
    "look into",
    "locate",
    "find",
    "see",
    "where is",
    "what files",
    "list files",
    "what file",
  ];

  const folderMention = /\b([a-z0-9_-]+)\s+(folder|directory)\b/i.test(msg);

  return hasWorkspaceReference(message) && (folderMention || accessWords.some((w) => msg.includes(w)));
}

function isWorkspaceCodeRequest(message) {
  const msg = String(message || "").toLowerCase();

  const codeWords = [
    "give me code",
    "show code",
    "paste code",
    "full code",
    "content code",
    "send code",
    "whole code",
    "source code",
    "file code",
    "loginform content code",
    "give me the code",
    "show me the code",
    "send me the code",
  ];

  const wantsCode = codeWords.some((w) => msg.includes(w));
  return hasWorkspaceReference(message) && wantsCode;
}

function isWorkspaceModificationRequest(message) {
  const msg = String(message || '').toLowerCase();

  const modifyWords = [
    'change', 'update', 'modify', 'edit', 'refactor',
    'match', 'sync', 'align', 'same style', 'same colors',
    'same design', 'redesign', 'improve', 'replace',
    'migrate', 'fix', 'adjust', 'design', 'style',
    'colors', 'theme', 'add signup', 'add sign up',
    'sign up option',
    
    // ✅ جدید - این‌ها رو اضافه کن
    'add',           // "add sign up option"
    'implement',     // "implement sign up form"
    'create',        // "create sign up"
    'insert',        // "insert button"
    'put',           // "put sign up"
    'append',        // "append option"
    'include',       // "include sign up"
    'sign up',       // عبارت کامل
    'signup',
    'register',
    'new route',
    'another route',
    'new page',
    'new form',
    'under the',     // "under the sign in button"
    'below the',     // "below the button"
  ];

  // چک کن هم workspace reference داره هم modify word
  const hasModify = modifyWords.some((w) => msg.includes(w));
  
  // اگر "add" یا "implement" داره، مستقیم modification هست
  const hasStrongModify = ['add', 'implement', 'create', 'insert', 'put', 'append']
    .some(w => msg.includes(w));

  return (hasWorkspaceReference(message) && hasModify) || 
         (hasStrongModify && hasWorkspaceReference(message));
}

function isTechnicalRequest(message) {
  const msg = String(message || "").toLowerCase();

  const technicalKeywords = [
    "api",
    "backend",
    "frontend",
    "database",
    "auth",
    "dashboard",
    "react",
    "vue",
    "node",
    "fastify",
    "express",
    "postgresql",
    "mongodb",
    "microservice",
    "rest",
    "graphql",
    "websocket",
    "دیتابیس",
    "بک‌اند",
    "فرانت‌اند",
    "داشبورد",
    "احراز هویت",
    "page.tsx",
    "layout.tsx",
    "globals.css",
    "component",
    "file",
    "code",
    "design",
    "style",
    "match",
    "sync",
    "access",
    "inspect",
    "read",
    "login page",
    "sidebar",
    "chatbot",
    "folder",
    "directory",
    "workspace",
  ];

  return technicalKeywords.some((kw) => msg.includes(kw));
}

function isVagueRequest(message) {
  const msg = String(message || "");

  const vaguePatterns = [
    /create\s+(a\s+)?dashboard/i,
    /build\s+(a\s+)?website/i,
    /make\s+(an?\s+)?app/i,
    /develop\s+(a\s+)?system/i,
    /بساز\s+داشبورد/i,
    /بساز\s+وب‌سایت/i,
    /بساز\s+اپلیکیشن/i,
    /make\s+the\s+login\s+page/i,
    /match\s+the\s+design/i,
    /sync\s+the\s+design/i,
    /same\s+colors/i,
    /same\s+style/i,
  ];

  return vaguePatterns.some((pattern) => pattern.test(msg));
}

function detectRequestMode(userMessage) {
  const trimmed = String(userMessage || "").trim();
  const lower = trimmed.toLowerCase();

  if (isCrisis(trimmed)) return "crisis";
  if (isGreeting(trimmed)) return "greeting";

  if (isWorkspaceInspectionRequest(trimmed)) return "inspection";
  if (isWorkspaceCodeRequest(trimmed)) return "code_request";
  if (isWorkspaceModificationRequest(trimmed)) return "modification";

  if (isVagueRequest(trimmed) && !isTechnicalRequest(trimmed)) {
    return "clarification";
  }

  if (isTechnicalRequest(lower)) return "technical";

  if (trimmed.length < 15 || trimmed.split(/\s+/).length < 4) {
    return "casual";
  }

  return "casual";
}

function detectTaskType(userMessage) {
  const msg = normalizeText(userMessage);

  const frontendSignals = [
    "sidebar",
    "component",
    "page",
    "ui",
    "layout",
    "navbar",
    "header",
    "footer",
    "card",
    "modal",
    "drawer",
    "chatgpt",
    "chatbot",
    "react",
    "next",
    "tailwind",
    "lucide",
    "animation",
    "input",
    "chat",
    "login",
    "page.tsx",
    "layout.tsx",
    "globals.css",
  ];

  const backendSignals = [
    "api",
    "endpoint",
    "route",
    "server",
    "database",
    "schema",
    "auth",
    "controller",
    "service",
    "repository",
    "fastify",
    "express",
  ];

  const testSignals = ["test", "spec", "vitest", "jest", "playwright", "e2e"];
  const bugSignals = ["bug", "fix", "error", "issue", "broken", "crash"];
  const refactorSignals = ["refactor", "cleanup", "optimize", "reorganize"];

  const hasFrontend = frontendSignals.some((kw) => containsWord(msg, kw));
  const hasBackend = backendSignals.some((kw) => containsWord(msg, kw));
  const hasTests = testSignals.some((kw) => containsWord(msg, kw));
  const hasBug = bugSignals.some((kw) => containsWord(msg, kw));
  const hasRefactor = refactorSignals.some((kw) => containsWord(msg, kw));
  const requestMode = detectRequestMode(msg);

  if (requestMode === "inspection") return "inspection";
  if (requestMode === "code_request") return "code_request";
  if (requestMode === "modification") return "modification";
  if (requestMode === "clarification") return "clarification";
  if (requestMode === "greeting") return "greeting";
  if (requestMode === "crisis") return "crisis";
  if (requestMode === "casual") return "casual";

  if (hasTests) return "test_generation";
  if (hasBug) return "bug_fix";
  if (hasRefactor) return "refactor";

  if (hasFrontend && containsWord(msg, "page")) return "frontend_page";
  if (hasFrontend) return "frontend_component";
  if (hasBackend) return "backend_api";

  return "feature";
}

function detectProjectScope(userMessage) {
  const msg = normalizeText(userMessage);

  const frontendKeywords = [
    "frontend",
    "front-end",
    "ui",
    "react",
    "vue",
    "component",
    "page",
    "routing",
    "state management",
    "sidebar",
    "chatbot",
    "next",
    "tailwind",
    "animation",
    "login",
  ];
  const backendKeywords = [
    "backend",
    "back-end",
    "api",
    "server",
    "database",
    "auth",
    "fastify",
    "express",
    "endpoint",
    "route",
  ];

  const hasFrontend = frontendKeywords.some((kw) => msg.includes(kw));
  const hasBackend = backendKeywords.some((kw) => msg.includes(kw));

  if (hasFrontend && hasBackend) return "fullstack";
  if (hasFrontend) return "frontend";
  if (hasBackend) return "backend";
  return "unknown";
}

function buildResolvedPathCandidates(candidatePath) {
  const cleaned = stripPathNoise(candidatePath).replace(/^\/+/, "");
  const variants = new Set([cleaned]);

  if (cleaned.startsWith("frontend/")) {
    variants.add(cleaned.slice("frontend/".length));
  }
  if (cleaned.startsWith("backend/")) {
    variants.add(cleaned.slice("backend/".length));
  }

  const resolved = [];
  for (const variant of variants) {
    if (!variant) continue;
    resolved.push(path.join(PROJECT_ROOT, variant));
    resolved.push(path.join(FRONTEND_ROOT, variant));
    resolved.push(path.join(BACKEND_ROOT, variant));
  }

  return uniq(resolved);
}

function formatSmartContext(ctx, title = "smart-context") {
  if (!ctx) return "";

  const parts = [];

  if (Array.isArray(ctx.filenameMatches) && ctx.filenameMatches.length > 0) {
    parts.push(`=== ${title}: filename matches ===\n${ctx.filenameMatches.join("\n")}`);
  }

  if (Array.isArray(ctx.relevantFiles) && ctx.relevantFiles.length > 0) {
    parts.push(`=== ${title}: relevant files ===\n${ctx.relevantFiles.join("\n")}`);
  }

  if (Array.isArray(ctx.files) && ctx.files.length > 0) {
    parts.push(`=== ${title}: selected files ===\n${ctx.files.join("\n")}`);
  }

  if (Array.isArray(ctx.chunks) && ctx.chunks.length > 0) {
    const chunkText = ctx.chunks
      .map((c) => `FILE: ${c.path}\n${String(c.content || "").slice(0, 2200)}`)
      .join("\n---\n");
    parts.push(`=== ${title}: file chunks ===\n${chunkText}`);
  }

  if (ctx.dependencyGraph && Object.keys(ctx.dependencyGraph).length > 0) {
    parts.push(
      `=== ${title}: dependency graph ===\n${JSON.stringify(ctx.dependencyGraph, null, 2)}`
    );
  }

  return parts.join("\n\n");
}

// --------- File discovery ----------
async function findFilesByName(filename, { dir = "", limit = 10 } = {}) {
  const target = stripPathNoise(filename).toLowerCase();
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
        filePath.includes("frontend/") || filePath.includes("app/") || filePath.includes("src/")
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

async function collectInspectionTargets(userMessage) {
  const hints = [];

  // 1) فایل‌های صریح از متن پیام
  const explicitFiles = extractCandidateFilePaths(userMessage);
  hints.push(...explicitFiles);

  // 2) keyword matching موجود
  const msg = String(userMessage || "").toLowerCase();
  const folderMatch = msg.match(/\b([a-z0-9._-]+)\s+(folder|directory)\b/i);
  if (folderMatch?.[1]) hints.push(folderMatch[1]);

  if (msg.includes("page"))      hints.push("page.tsx", "page.jsx");
  if (msg.includes("layout"))    hints.push("layout.tsx", "layout.jsx");
  if (msg.includes("globals"))   hints.push("globals.css", "globals.scss");
  if (msg.includes("login"))     hints.push("login.tsx", "login/page.tsx", "LoginForm.tsx");
  if (msg.includes("sidebar"))   hints.push("sidebar.tsx", "Sidebar.tsx");
  if (msg.includes("header"))    hints.push("header.tsx", "Header.tsx");
  if (msg.includes("chatbot"))   hints.push("chatbot", "my-chatbot-ui", "page.tsx");
  if (msg.includes("loginform")) hints.push("LoginForm.tsx", "LoginForm.jsx");
  if (msg.includes("register") || msg.includes("signup")) {
    hints.push("RegisterForm.tsx", "SignupForm.tsx", "register/page.tsx", "signup/page.tsx");
  }
  if (msg.includes("form"))      hints.push("Form.tsx", "form.tsx");
  if (msg.includes("button"))    hints.push("Button.tsx", "button.tsx");
  if (msg.includes("modal"))     hints.push("Modal.tsx", "modal.tsx");
  if (msg.includes("navbar"))    hints.push("Navbar.tsx", "NavBar.tsx", "navbar.tsx");
  if (msg.includes("dashboard")) hints.push("dashboard/page.tsx", "Dashboard.tsx");
  if (msg.includes("auth"))      hints.push("auth.ts", "auth.tsx", "auth/page.tsx", "[...nextauth]");

  // 3) *** بخش جدید: اسکن کامل پروژه برای یافتن فایل‌های مرتبط ***
  // اگر hints کافی نبود، یک اسکن عمیق‌تر انجام می‌دهیم
  if (hints.length < 3) {
    try {
      // اسکن frontend برای یافتن همه فایل‌های tsx/jsx/ts/js
      const frontendScan = await listBackendFiles({
        dir: FRONTEND_CWD_REL,
        maxDepth: 8,
        includeFiles: true,
        includeDirs: false,
        includeMeta: false,
      });

      if (frontendScan?.success && Array.isArray(frontendScan.files)) {
        // فیلتر فایل‌های مرتبط بر اساس کلمات کلیدی در path
        const keywords = msg
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .map((w) => w.toLowerCase());

        for (const file of frontendScan.files) {
          const fileLower = file.path.toLowerCase();
          if (keywords.some((kw) => fileLower.includes(kw))) {
            hints.push(file.path);
          }
        }
      }
    } catch (e) {
      console.warn("collectInspectionTargets scan failed:", e.message);
    }
  }

  // 4) dedup و جستجو
  const uniqueHints = uniq(hints.map((h) => String(h || "").trim()).filter(Boolean));
  const found = [];
  const seen = new Set();

  for (const hint of uniqueHints) {
    const matches = await findFilesByName(hint, { dir: "", limit: 8 });

    for (const file of matches) {
      if (seen.has(file)) continue;
      seen.add(file);
      found.push(file);

      if (found.length >= 15) return found;
    }
  }

  // 5) *** fallback: اگر هنوز چیزی پیدا نشد، اسکن مستقیم برمی‌گرداند ***
  if (found.length === 0) {
    try {
      const fallbackScan = await listBackendFiles({
        dir: FRONTEND_CWD_REL,
        maxDepth: 8,
        includeFiles: true,
        includeDirs: false,
        includeMeta: false,
      });

      if (fallbackScan?.success && Array.isArray(fallbackScan.files)) {
        const keywords = msg
          .split(/\s+/)
          .filter((w) => w.length > 3);

        for (const file of fallbackScan.files) {
          const fileLower = file.path.toLowerCase();
          if (keywords.some((kw) => fileLower.includes(kw))) {
            found.push(file.path);
            if (found.length >= 15) break;
          }
        }
      }
    } catch (e) {
      console.warn("collectInspectionTargets fallback failed:", e.message);
    }
  }

  return found;
}


async function readFileIfExists(relPath) {
  try {
    const res = await readProjectFile({ path: relPath, maxBytes: 120000 });
    const content = typeof res === "string" ? res : res?.content || "";
    return content ? String(content) : "";
  } catch {
    return "";
  }
}

function inferLanguageFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx" || ext === ".ts") return "ts";
  if (ext === ".jsx" || ext === ".js") return "js";
  if (ext === ".css") return "css";
  if (ext === ".scss") return "scss";
  if (ext === ".json") return "json";
  if (ext === ".md") return "md";
  return "";
}

function stripToPreview(content, maxChars = 1800) {
  const text = String(content || "").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

function formatFileSnippet(filePath, content) {
  const language = inferLanguageFromPath(filePath);
  const code = String(content || "").trim();
  return `FILE: ${filePath}\n${language ? `\`\`\`${language}\n` : "```"}${code}\n\`\`\``;
}

async function readExactReferencedFiles(userMessage) {
  const candidatePaths = extractCandidateFilePaths(userMessage);
  if (!candidatePaths.length) return [];

  const snippets = [];
  const seen = new Set();

  for (const candidate of candidatePaths) {
    const resolvedCandidates = buildResolvedPathCandidates(candidate);

    for (const absPath of resolvedCandidates) {
      const relPath = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, "/");

      if (seen.has(relPath)) continue;
      if (!fs.existsSync(absPath)) continue;

      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;

      const content = await readFileIfExists(relPath);
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

async function collectReferenceSnippets(userMessage) {
  const seen = new Set();
  const snippets = [];

  const hints = uniq([
    ...DESIGN_REFERENCE_FILENAMES,
    ...extractCandidateFilePaths(userMessage),
  ]);

  for (const name of hints) {
    const matches = await findFilesByName(name, {
      dir: "",
      limit: 3,
    });

    for (const relPath of matches) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);

      const content = await readFileIfExists(relPath);
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

async function summarizeProjectStructure(scope) {
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
    summary.backend = await collect("backend", BACKEND_CWD_REL);
  }

  if (scope === "frontend" || scope === "fullstack" || scope === "unknown") {
    summary.frontend = await collect("frontend", FRONTEND_CWD_REL);
  }

  return summary;
}

async function buildReferenceFileContext(userMessage) {
  const smartContext = await buildSmartContext({
    userMessage,
    maxFiles: 12,
    dependencyDepth: 2,
  });

  const exactFiles = await readExactReferencedFiles(userMessage);
  const referenceSnippets = await collectReferenceSnippets(userMessage);
  const inspectionTargets = await collectInspectionTargets(userMessage);

  return {
    smartContext,
    exactFiles,
    referenceSnippets,
    inspectionTargets,
  };
}

function buildSystemPrompt(taskType, taskScope, requestMode) {
  return `
You are a senior software planning agent.

Your job is to produce a task-level implementation plan that is exact, practical, and aligned with the user's request.

Rules:
- Return ONLY valid JSON.
- No markdown.
- No code fences.
- No explanations outside JSON.
- The output must be directly usable by a code generation agent.
- Keep the plan focused and small when the request is about a single UI task or file.
- Use the workspace context carefully.
- Prefer existing project conventions.
- Do not invent unrelated files.
- If the user asks to inspect a file or folder, prioritize locating exact files and reading them.
- If the user asks for code, prioritize the exact file content and source snippets in the plan.
- If the user references a filename like page.tsx, locate it in the workspace even when the full path is not given.
- If the request is a code-request or inspection request, set the plan to point at exact files and preserve source fidelity.
- If the request is a UI matching task, derive style tokens from the reference files and keep the output visually consistent.
- Do not claim lack of access if files were found in the workspace context.

Output schema:
{
  "task_type": "task",
  "request_mode": "inspection" | "code_request" | "modification" | "clarification" | "technical" | "greeting" | "crisis" | "casual",
  "name": string,
  "task_scope": "frontend" | "backend" | "fullstack" | "unknown",
  "goal": string,
  "summary": string,
  "target_files": string[],
  "reference_files": string[],
  "context_assumptions": string[],
  "files_to_create": [
    {
      "path": string,
      "purpose": string,
      "content": string
    }
  ],
  "files_to_modify": [
    {
      "path": string,
      "purpose": string,
      "content": string
    }
  ],
  "dependencies": string[],
  "constraints": string[],
  "acceptance_criteria": string[],
  "notes": string,
  "response_style": "plan" | "code" | "explanation"
}

Detected task type hint: ${taskType}
Detected task scope: ${taskScope}
Detected request mode: ${requestMode}
`.trim();
}

function buildUserPrompt({
  userMessage,
  taskType,
  taskScope,
  requestMode,
  projectStructure,
  smartContextText,
  exactFilesText,
  referenceSnippetsText,
  inspectionTargetsText,
}) {
  return `
User request:
${userMessage}

Task classification:
- task_type: ${taskType}
- request_mode: ${requestMode}
- task_scope: ${taskScope}

Likely target files:
${inspectionTargetsText || "<none>"}

Project structure:
--- frontend ---
${projectStructure.frontend || "<none>"}

--- backend ---
${projectStructure.backend || "<none>"}

Exact referenced file snippets:
${exactFilesText || "<none>"}

Design/reference file snippets:
${referenceSnippetsText || "<none>"}

Advanced semantic workspace context:
${smartContextText || "<none>"}

Instructions:
- If the request is about reading or inspecting a file, point the plan at the exact file(s) and preserve their content context.
- If the request is about code, make the plan precise enough for direct implementation.
- If the request is about visual matching, derive style from the reference files and keep the plan narrow.
- Do not expand into unrelated architecture work.
- Do not add deployment, CI/CD, or unrelated refactors.
`.trim();
}

// --------- Core planner ----------
async function runPlanner(userMessage) {
  if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
    throw new Error("userMessage is required");
  }

  console.log("🧠 Task planner started...");
  console.log("Project root:", PROJECT_ROOT);
  console.log("Goal:", userMessage);

  const requestMode = detectRequestMode(userMessage);
  const taskType = detectTaskType(userMessage);
  let taskScope = detectProjectScope(userMessage);

  if (taskScope === "unknown") {
    taskScope = inferTaskScopeFromType(taskType);

    if (taskScope === "unknown") {
      const scopeDetectionResp = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              'You are a task scope detector. Given a user request, determine if it is "frontend", "backend", or "fullstack". Reply with ONLY one word: frontend, backend, or fullstack.',
          },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
        max_tokens: 10,
      });

      const detectedScope = scopeDetectionResp.choices?.[0]?.message?.content?.trim().toLowerCase();

      taskScope = ["frontend", "backend", "fullstack"].includes(detectedScope)
        ? detectedScope
        : "fullstack";
    }
  }

  console.log("📊 Detected task type:", taskType);
  console.log("🧭 Request mode:", requestMode);
  console.log("📦 Detected scope:", taskScope);

  const projectStructure = await summarizeProjectStructure(taskScope);
  const {
    smartContext,
    exactFiles,
    referenceSnippets,
    inspectionTargets,
  } = await buildReferenceFileContext(userMessage);

  const smartContextText = formatSmartContext(smartContext, "workspace");
  const exactFilesText = exactFiles.length
    ? exactFiles
        .map((file) => `FILE: ${file.path}\nSNIPPET:\n${file.content}\n---`)
        .join("\n")
    : "";

  const referenceSnippetsText = referenceSnippets.length
    ? referenceSnippets
        .map((file) => `FILE: ${file.path}\nSNIPPET:\n${file.content}\n---`)
        .join("\n")
    : "";

  const inspectionTargetsText = inspectionTargets.length
    ? inspectionTargets.map((f) => `- ${f}`).join("\n")
    : "";

  const systemPrompt = buildSystemPrompt(taskType, taskScope, requestMode);
  const userPrompt = buildUserPrompt({
    userMessage,
    taskType,
    taskScope,
    requestMode,
    projectStructure,
    smartContextText,
    exactFilesText,
    referenceSnippetsText,
    inspectionTargetsText,
  });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  const raw = resp.choices?.[0]?.message?.content || "";

  let parsed = safeJsonParse(raw);
  if (!parsed.ok) {
    const candidate = extractLikelyJsonObject(raw);
    if (candidate) parsed = safeJsonParse(candidate);
  }

  if (!parsed.ok) {
    console.error("❌ Planner returned non-JSON. Raw:");
    console.error(raw);
    throw parsed.error;
  }

  const plan = parsed.value || {};

  plan.task_type = "task";
  plan.request_mode = plan.request_mode || requestMode;
  plan.task_scope = plan.task_scope || taskScope;
  plan.target_files = Array.isArray(plan.target_files) ? plan.target_files : inspectionTargets;
  plan.reference_files = Array.isArray(plan.reference_files)
    ? plan.reference_files
    : uniq([
        ...exactFiles.map((f) => f.path),
        ...referenceSnippets.map((f) => f.path),
      ]);

  if (!Array.isArray(plan.context_assumptions)) plan.context_assumptions = [];
  if (!Array.isArray(plan.files_to_create)) plan.files_to_create = [];
  if (!Array.isArray(plan.files_to_modify)) plan.files_to_modify = [];
  if (!Array.isArray(plan.dependencies)) plan.dependencies = [];
  if (!Array.isArray(plan.constraints)) plan.constraints = [];
  if (!Array.isArray(plan.acceptance_criteria)) plan.acceptance_criteria = [];
  if (typeof plan.notes !== "string") plan.notes = "";
  if (!plan.response_style) {
    plan.response_style =
      requestMode === "code_request"
        ? "code"
        : requestMode === "inspection"
          ? "explanation"
          : "plan";
  }

  console.log("\n📋 Generated Task Plan (JSON):\n");
  console.log(JSON.stringify(plan, null, 2));

  const outPath = path.join(PROJECT_ROOT, "planner_plan.json");
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf8");
  console.log(`\n💾 Plan saved to: ${outPath}`);

  return plan;
}

// --------- CLI ----------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliGoal = process.argv.slice(2).join(" ");
  if (!cliGoal) {
    console.error("Usage: node planner.js <your request>");
    process.exit(1);
  }

  runPlanner(cliGoal).catch((err) => {
    console.error("❌ Planner crashed:", err);
    process.exit(1);
  });
}

export { runPlanner };