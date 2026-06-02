export function normalizeText(value) {
  return String(value || "").toLowerCase();
}

export function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

export function stripPathNoise(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[),.;:]+$/g, "");
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export function extractLikelyJsonObject(raw) {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return raw.slice(first, last + 1);
}

export function containsWord(text, word) {
  const regex = new RegExp(`\\b${word}\\b`, "i");
  return regex.test(text);
}

export function inferTaskScopeFromType(taskType) {
  if (taskType.startsWith("frontend_")) return "frontend";
  if (taskType.startsWith("backend_")) return "backend";
  if (taskType === "fullstack_feature") return "fullstack";
  return "unknown";
}

export function detectLanguage(text) {
  const englishChars = (String(text || "").match(/[a-zA-Z]/g) || []).length;
  const farsiChars = (String(text || "").match(/[\u0600-\u06FF]/g) || []).length;
  return englishChars > farsiChars ? "en" : "fa";
}

export function isGreeting(message) {
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

  return GREETING_PATTERNS.some((pattern) =>
    pattern.test(String(message || "").trim())
  );
}

export function isCrisis(message) {
  const lower = String(message || "")
    .toLowerCase()
    .replace(/[^a-z\u0600-\u06FF\s]/g, " ");

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

export function extractCandidateFilePaths(message) {
  const msg = String(message || "");

  const pathRegex =
    /(?:\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js))/g;

  const filenameRegex =
    /\b[A-Za-z0-9._-]+\.(?:tsx?|jsx?|css|scss|md|json|ya?ml|html|xml|mjs|cjs|ts|js)\b/g;

  const matches = [
    ...(msg.match(pathRegex) || []),
    ...(msg.match(filenameRegex) || []),
  ];

  return uniq(matches.map((m) => String(m || "").trim()).filter(Boolean)).map(
    stripPathNoise
  );
}

export function hasWorkspaceReference(message) {
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
    "routes",
    "uploads",
  ];

  return (
    extractCandidateFilePaths(message).length > 0 ||
    fileishWords.some((w) => msg.includes(w))
  );
}

export function isWorkspaceInspectionRequest(message) {
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
    "which file",
    "where should i",
    "what file do you want to update",
    "what file should i",
    "which file should i",
  ];

  const folderMention = /\b([a-z0-9_-]+)\s+(folder|directory)\b/i.test(msg);

  return (
    hasWorkspaceReference(message) &&
    (folderMention || accessWords.some((w) => msg.includes(w)))
  );
}

export function isWorkspaceCodeRequest(message) {
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
    "loginform content code",
    "component code",
    "file code",
    "give me the code",
    "show me the code",
    "full file",
    "full content",
  ];

  const wantsCode = codeWords.some((w) => msg.includes(w));
  return hasWorkspaceReference(message) && wantsCode;
}

export function wantsBuildFromAttachment(message, attachments = []) {
  const msg = String(message || "").toLowerCase();
  if (!attachments.length) return false;

  const buildWords = [
    "create",
    "build",
    "make",
    "implement",
    "design",
    "generate",
    "recreate",
    "clone",
    "copy",
    "match",
    "convert",
    "turn this into",
    "based on this",
    "based on these",
    "using this",
    "using these",
    "use this",
    "use these",
    "from this",
    "from these",
    "like this",
    "similar to this",
    "according to this",
    "this image",
    "this screenshot",
    "this file",
    "this design",
  ];

  return buildWords.some((w) => msg.includes(w));
}

export function isWorkspaceModificationRequest(message) {
  const msg = String(message || "").toLowerCase();

  const modifyWords = [
    "change",
    "update",
    "modify",
    "edit",
    "refactor",
    "match",
    "sync",
    "align",
    "same style",
    "same colors",
    "same design",
    "redesign",
    "improve",
    "replace",
    "migrate",
    "fix",
    "adjust",
    "design",
    "style",
    "colors",
    "theme",
    "add signup",
    "add sign up",
    "sign up option",
    "signup option",
    "insert",
    "add",
    "implement",
    "create",
    "include",
    "append",
    "below the",
    "under the",
  ];

  const hasModify = modifyWords.some((w) => msg.includes(w));
  const hasStrongModify = ["add", "implement", "create", "insert", "append", "include"].some(
    (w) => msg.includes(w)
  );

  return (
    (hasWorkspaceReference(message) && hasModify) ||
    (hasStrongModify && hasWorkspaceReference(message))
  );
}

export function isTechnicalRequest(message) {
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
    "upload",
    "image",
    "screenshot",
    "file input",
    "attachment",
  ];

  return technicalKeywords.some((kw) => msg.includes(kw));
}

export function isVagueRequest(message) {
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

export function detectRequestMode(userMessage) {
  const trimmed = String(userMessage || "").trim();
  const lower = trimmed.toLowerCase();

  if (isCrisis(trimmed)) return "crisis";
  if (isGreeting(trimmed)) return "greeting";

  if (isWorkspaceInspectionRequest(trimmed)) return "inspection";
  if (isWorkspaceCodeRequest(trimmed)) return "code_request";
  if (isWorkspaceModificationRequest(trimmed)) return "modification";

  if (isVagueRequest(trimmed) && !isTechnicalRequest(trimmed)) return "clarification";
  if (isTechnicalRequest(lower)) return "technical";

  if (trimmed.length < 15 || trimmed.split(/\s+/).length < 4) return "casual";
  return "casual";
}

export function detectTaskType(userMessage) {
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

export function detectProjectScope(userMessage) {
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