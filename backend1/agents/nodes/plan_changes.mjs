/**
 * plan_changes.mjs
 * Builds structured patch plans from evidence + investigation.
 *
 * Goals:
 * - Keep prompts small enough to avoid provider timeouts.
 * - Prefer the remembered/target file and investigation priority files.
 * - Canonicalize plan paths to exact workspace paths when possible.
 * - Retry once on transient LLM failures.
 */

import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AIMessage } from "@langchain/core/messages";
import { callLLM } from "../../services/llm.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PC_PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

const MAX_PROMPT_FILES = 5;
const MAX_FILE_CHARS = 15000; // raised from 10000 so 12-15KB files aren't truncated
const MAX_TOTAL_CONTEXT_CHARS = 20000;

// ── Model-aware context budget ──────────────────────────────────────────────────
// These constants were previously used as flat limits for EVERY model, from an
// 8k-token small model up to a 128k+-token large one — wasting most of a capable
// model's context and forcing needless truncation (which is what caused the
// keyword-windowing bug in shortenContentSmart to matter in the first place).
// Claude Code sizes its context usage to what the active model can actually hold;
// this resolves the same way, using the model name from modelRoute as a signal.
const MODEL_CONTEXT_TOKENS = [
  { pattern: /qwen3-coder|qwen.?3.*coder/i, tokens: 128_000 },
  { pattern: /gpt-5|gpt-4\.1|gpt-4o/i,      tokens: 128_000 },
  { pattern: /claude|opus|sonnet|haiku/i,   tokens: 180_000 },
  { pattern: /gemini/i,                     tokens: 128_000 },
  { pattern: /deepseek/i,                   tokens: 64_000 },
  { pattern: /llama-3\.[13]/i,              tokens: 128_000 },
  { pattern: /qwen/i,                       tokens: 32_000 }, // other qwen variants — conservative middle ground
];
const DEFAULT_CONTEXT_TOKENS = 8_000; // unknown model — matches this codebase's prior hardcoded assumption
const CHARS_PER_TOKEN = 3.5; // conservative for code (denser than prose)

function resolveContextBudget(modelRoute) {
  const modelName = String(modelRoute?.model || "").toLowerCase();
  const match = MODEL_CONTEXT_TOKENS.find((m) => m.pattern.test(modelName));
  const contextTokens = match?.tokens || DEFAULT_CONTEXT_TOKENS;

  // Reserve room for the system prompt, conversation history, and the JSON plan
  // output itself (patches can be large — always keep headroom for the response).
  const reservedTokens = 4500;
  const availableTokens = Math.max(contextTokens - reservedTokens, 3000);
  const totalContextChars = Math.floor(availableTokens * CHARS_PER_TOKEN);

  // Never regress below the previous hardcoded defaults for small/unknown models,
  // and cap each file's share so one huge file can't eat the whole budget alone.
  const boundedTotal = Math.max(totalContextChars, MAX_TOTAL_CONTEXT_CHARS);
  const maxFileChars = Math.max(Math.floor(boundedTotal * 0.7), MAX_FILE_CHARS);

  return { maxFileChars, totalContextChars: boundedTotal };
}

// ── Self-healing: load missing files when the plan is all read_only ────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", "uploads", ".agent-history", ".kodo", ".claude", ".vscode", ".idea"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

async function findWorkspaceFiles(projectRoot, dir = projectRoot, depth = 0) {
  if (depth > 9) return [];
  const results = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
    if (e.isDirectory()) {
      results.push(...await findWorkspaceFiles(projectRoot, abs, depth + 1));
    } else if (CODE_EXTS.has(path.extname(e.name).toLowerCase())) {
      results.push(rel);
    }
  }
  return results;
}

async function selfHealLoadMissingFiles(plan, fileContext, root, userMsg, emit) {
  const descriptions = plan.map(s => `${s.description || ""} ${s.path || ""}`).join(" ");
  const loadedPaths = new Set((fileContext || []).map(f => f?.path).filter(Boolean));
  const newFiles = [];

  const allFiles = await findWorkspaceFiles(root);

  // Extract PascalCase words from descriptions — likely component names
  const componentNames = [...new Set([...descriptions.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)].map(m => m[1]))];

  for (const name of componentNames) {
    const lowerName = name.toLowerCase();
    const match = allFiles.find(f => {
      const base = path.basename(f, path.extname(f)).toLowerCase();
      return base === lowerName;
    });
    if (match && !loadedPaths.has(match)) {
      try {
        const content = await fs.readFile(path.resolve(root, match), "utf-8");
        newFiles.push({ path: match, content, size: content.length, score: 250 });
        loadedPaths.add(match);
        emit?.({ type: "progress", stage: "planning", message: `📖 Loading missing file: ${path.basename(match)}` });
        console.log(`[PlanChanges] Self-heal: loaded ${match}`);
      } catch {}
    }
  }

  // Fallback: "user message" with no component found → load the main page.
  // Skip if the file context is backend-focused (loading page.tsx would confuse the planner).
  // Use the CLEAN message only — conversation memory often contains "user message" from prior
  // turns and incorrectly triggers this fallback when editing unrelated files.
  const isBackendTask = (fileContext || []).some(f => /\bbackend\b|\broutes?\b|\bserver\.mjs\b/i.test(f?.path || ""));
  const cleanUserMsgForHeal = String(userMsg || "").split(/conversation memory:/i)[0].trim();
  if (newFiles.length === 0 && !isBackendTask && /\buser.?message\b|\bchat.?bubble\b|\bmessage.?bubble\b/i.test(descriptions + " " + cleanUserMsgForHeal)) {
    const pageTsx = allFiles.find(f => path.basename(f) === "page.tsx" && f.includes("app/page"));
    if (pageTsx && !loadedPaths.has(pageTsx)) {
      try {
        const raw = await fs.readFile(path.resolve(root, pageTsx), "utf-8");
        // page.tsx is large (~800 lines). shortenContentSmart picks the wrong
        // window (copyToClipboard fn body) missing the JSX message rendering at
        // line ~700+. Pre-trim: show imports (top 60 lines) + message render area.
        const rawLines = raw.split("\n");
        // Match the JSX message-loop entry: "{messages.map((m)" or "{m.role === "user""
        // Avoid early filter() calls like "(m) => m.role === ..." by requiring { prefix.
        const renderStart = rawLines.findIndex(
          (l, i) => i > 50 && (/\{\s*messages\s*\.\s*map\s*\(/.test(l) || /\{\s*m\s*\.\s*role\s*===/.test(l))
        );
        let content = raw;
        if (renderStart > 60) {
          const header = rawLines.slice(0, 60);
          const renderArea = rawLines.slice(Math.max(60, renderStart - 20), Math.min(rawLines.length, renderStart + 250));
          content = [
            ...header,
            "",
            "// ── [file truncated — showing message rendering area] ──",
            "",
            ...renderArea,
          ].join("\n");
          console.log(`[PlanChanges] Self-heal: page.tsx trimmed to render area (abs line ${renderStart})`);
        }
        newFiles.push({ path: pageTsx, content, size: content.length, score: 250 });
        emit?.({ type: "progress", stage: "planning", message: `📖 Loading page.tsx — user messages rendered here` });
        console.log(`[PlanChanges] Self-heal fallback: loaded ${pageTsx}`);
      } catch {}
    }
  }

  return newFiles;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMultiTaskRequest(msg) {
  const m = String(msg || "");
  // Numbered list: "1. ...", "**1. ...", "1- ...", "1) ..." — optional markdown bold before digit
  const numberedItem = /(?:^|[\n\r])\s*(?:\*{1,2})?[1-5][.\-\)]\s*\S/;
  const secondItem   = /(?:^|[\n\r])\s*(?:\*{1,2})?[2-5][.\-\)]\s*\S/;
  if (numberedItem.test(m) && secondItem.test(m)) return true;
  // Inline "1- ... 2- ..." or "1. ... 2. ..." on the same line
  if (/\b1[.\-\)]\s*.{3,80}[,\n]?\s*2[.\-\)]\s*\S/s.test(m)) return true;
  // Explicit count words
  if (/\b(two|three|four|five|2|3|4|5)\s+(things?|changes?|tasks?|items?|fixes?|improvements?|updates?)\b/i.test(m)) return true;
  // Multiple conjunctions connecting distinct actions
  if (/\b(also|additionally|furthermore|moreover|plus|as well as|on top of that)\b/i.test(m)) return true;
  // Comma-separated actions — expanded verb list (includes give/show/display/set/enable)
  if (/\b(create|make|add|fix|change|update|remove|improve|build|implement|design|move|refactor|rewrite|give|show|display|set|enable)\b.{3,80},\s+(?:and\s+)?\b(create|make|add|fix|change|update|remove|improve|build|implement|design|move|refactor|rewrite|give|show|display|set|enable)\b/i.test(m)) return true;
  // "I want X things"
  if (/\bi\s+(?:want|need|would like)\s+(?:to\s+(?:have\s+)?)?\d+\b/i.test(m)) return true;
  // "Edit these 2 files", "update 3 files"
  if (/\b(edit|update|change|modify|fix)\s+(?:these\s+)?([2-9]|two|three|four|five)\s+files?\b/i.test(m)) return true;
  return false;
}

function isCreativeRequest(msg) {
  // If the user pasted explicit Tailwind/CSS class values (e.g. "bg-emerald-400/80",
  // "text-slate-900"), this is a surgical edit — the exact styles are already specified.
  // Don't classify as creative just because the message contains "style" or "design".
  if (/\b(?:bg|text|border|shadow|ring|from|to|via)-[\w]+-\d{2,3}/.test(String(msg || ""))) return false;
  return /\b(creative|exciting|beautiful|stunning|amazing|cool|fancy|animate|animation|gradient|glow|shadow|color|colour|design|be creative|advanced|premium|modern|sleek|vibrant|dynamic|make it (pop|shine|stand out))\b/i.test(
    String(msg || "")
  );
}

// Reference-copy: user points at File A and says "make File B look like that".
// These tasks must NOT use creative mode — the instruction is "copy exactly", not "be bold".
// Pattern covers: "as the design reference", "as reference", "reuse the existing",
// "same success state/style/pattern/animation", "same as [component]", "same design".
function isReferenceCopyRequest(msg) {
  return /\bas (?:the )?(?:design )?reference\b|\breuse the existing\b|\bsame (?:success )?(?:style|design|pattern|animation|state)\b|\bsame as\b/i.test(
    String(msg || "")
  );
}

function isBugFixRequest(msg) {
  return /\b(fix|bug|error|crash|broken|failed|exception|stack trace|TypeError|ReferenceError|SyntaxError|Bad Request|404|500|401|503|not working|doesn't work|doesn.t work)\b/i.test(
    String(msg || "")
  );
}

function isLintFixRequest(msg) {
  const m = String(msg || "");
  // Specific rule names or tool names are unambiguous signals.
  if (/\b(no-explicit-any|no-unused-vars|no-unused|prefer-const|eslint|tslint)\b/i.test(m)) return true;
  // The bare words "lint"/"typecheck" are NOT — user content can quote them
  // ("the Verify step runs typecheck and lint" in landing-page copy once flipped
  // the planner into lint-fix mode on a design request). Require fix-intent
  // phrasing near the word, in either order.
  return (
    /\b(fix|resolve|clean\s*up|address|solve|correct)\b[^.\n]{0,40}\b(lint|linting|typecheck|type.check|type\s+errors?)\b/i.test(m) ||
    /\b(lint|linting|typecheck|type.check)\b[^.\n]{0,40}\b(errors?|warnings?|issues?|violations?|failures?|fix)\b/i.test(m)
  );
}

function isScopedChange(msg) {
  const m = String(msg || "").toLowerCase();
  // "move X" requires structural changes (fragment wrappers, reparenting) — not scoped
  if (/\bmove\b/.test(m)) return false;
  // "change button X in sidebar", "update the collapse icon", "make the search button red"
  return /\b(button|icon|toggle|link|input|badge|label|text|color|colour|style|class|className|title|placeholder)\b/.test(m)
    && /\b(in|inside|within|of|on|for|the)\b/.test(m);
}

function mentionsExplicitFile(msg) {
  const m = String(msg || "");
  if (/\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|html|ts|js|yml|yaml|py|rb|go|rs|java|php|sh|bash|txt|env)\b/i.test(m)) return true;
  if (/\b(sidebar|navbar|header|footer|composer|chatsidebar|chatheader|login|signup|connection|dashboard|settings|page|route|layout)\b/i.test(m))
    return true;
  return false;
}

function addLineNumbers(content) {
  return String(content || "")
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
}

function buildJsxOutline(content, filePath) {
  if (!/\.(tsx?|jsx?)$/.test(filePath)) return "";
  const lines = String(content || "").split("\n");
  const outline = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(return\s*[\(\{]|<[A-Z][a-zA-Z]*|<\/[A-Z][a-zA-Z]*|<div|<section|<main|<aside|<button|<span|<p\b)/.test(lines[i])) {
      outline.push(`L${i + 1}: ${lines[i].slice(0, 90).trimEnd()}`);
    }
  }

  if (outline.length === 0) return "";
  return `\n\n### Structure (${pathBase(filePath)}):\n${outline.slice(0, 30).join("\n")}`;
}

function pathBase(p) {
  return String(p || "").split("/").pop() || String(p || "");
}

function normalizeSnippet(content) {
  return String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function shortenContent(content, maxChars = MAX_FILE_CHARS) {
  const text = normalizeSnippet(content);
  if (text.length <= maxChars) return text;

  const headLen = Math.floor(maxChars * 0.55);
  const tailLen = maxChars - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);

  return `${head}\n... [truncated ${text.length - headLen - tailLen} chars]\n${tail}`;
}

function shortenContentSmart(content, maxChars, userMsg) {
  const text = normalizeSnippet(content);
  if (text.length <= maxChars) return text;

  const stopWords = new Set(["that", "this", "with", "from", "more", "have", "will", "just", "what", "your", "into", "over", "then", "them", "they", "make", "also", "each", "left", "right", "the", "not", "and", "but", "for", "are", "was", "its", "can", "all", "has", "had", "our", "out", "one", "you", "like", "same"]);
  // Deduplicate — duplicate words (e.g. "message bubble not inside message bubble")
  // inflate scores for irrelevant lines that happen to contain that word once.
  const keywords = [...new Set(String(userMsg || "")
    .toLowerCase()
    .replace(/[^\w\s[\]-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w)))];

  const lines = text.split("\n");
  const charsPerLine = Math.max(20, text.length / lines.length);

  if (keywords.length > 0) {
    // When the task is UI-related, boost JSX lines so the window lands on JSX
    // rendering rather than plain function bodies (e.g. copyToClipboard fn).
    const isUITask = /button|bubble|hover|component|render|icon|class|style|copy|color|colour|badge|label/i.test(userMsg);
    const scores = lines.map(line => {
      const lower = line.toLowerCase();
      let score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 1 : 0), 0);
      // JSX lines have closing tags, self-close markers, or JSX-specific attrs.
      // Avoid false-positives from TypeScript generics (useState<string>).
      if (isUITask && score > 0 && (/<\/[A-Za-z]|\/>|className=|onClick=|^\s*<[A-Za-z]/.test(line))) {
        score += 2; // prefer JSX context for UI tasks
      }
      return score;
    });

    const maxScore = Math.max(...scores);
    if (maxScore > 0) {
      const windowLines = Math.max(1, Math.floor(maxChars / charsPerLine));

      // Pick the window with the highest TOTAL keyword density, not just the single
      // highest-scoring line. A lone decoy line (e.g. a Tailwind "transition-opacity"
      // utility incidentally matching keyword "transition") can outscore the real
      // target if we only look at peaks — the real target is usually a cluster of
      // several relevant lines (button JSX + its handlers/state), which wins on
      // summed density even if no single line in it is the highest scorer.
      const clampedWindowLines = Math.min(windowLines, lines.length);
      const prefixSum = new Array(lines.length + 1).fill(0);
      for (let i = 0; i < scores.length; i++) prefixSum[i + 1] = prefixSum[i] + scores[i];

      let windowStart = 0;
      let bestSum = -1;
      for (let start = 0; start <= lines.length - clampedWindowLines; start++) {
        const sum = prefixSum[start + clampedWindowLines] - prefixSum[start];
        if (sum > bestSum) {
          bestSum = sum;
          windowStart = start;
        }
      }

      const headLines = Math.min(25, windowStart);
      windowStart = Math.max(headLines, windowStart);
      const windowEnd = Math.min(lines.length, windowStart + clampedWindowLines);

      const parts = [];
      if (headLines > 0) {
        parts.push(lines.slice(0, headLines).join("\n"));
      }
      if (windowStart > headLines) {
        parts.push(`... [lines ${headLines + 1}–${windowStart} not shown]`);
      }
      parts.push(lines.slice(windowStart, windowEnd).join("\n"));
      if (windowEnd < lines.length) {
        parts.push(`... [lines ${windowEnd + 1}–${lines.length} not shown]`);
      }

      return parts.join("\n");
    }
  }

  return shortenContent(content, maxChars);
}

function scoreFileForPrompt(file, cleanMsg, rememberedTargetFile, investigation) {
  const msg = String(cleanMsg || "").toLowerCase();
  const fp = String(file?.path || "").toLowerCase();
  const base = pathBase(fp).toLowerCase();
  let score = 0;

  // External web references (URL pseudo-files from agentic_explore) are the design/
  // content ground truth the user pointed at — they must survive the file cut.
  if (/^https?:\/\//.test(fp)) score += 180;

  // Skill guidance entries the explore agent chose to load — same protection.
  if (/^skill:/.test(fp)) score += 170;

  if (rememberedTargetFile) {
    const remembered = String(rememberedTargetFile).toLowerCase();
    const rememberedBase = pathBase(remembered);
    if (fp === remembered) score += 500;
    else if (fp.endsWith(remembered)) score += 250;
    else if (base === rememberedBase) score += 180;
  }

  const priorityFiles = Array.isArray(investigation?.priorityFiles) ? investigation.priorityFiles : [];
  for (const p of priorityFiles) {
    const pp = String(p || "").toLowerCase();
    if (!pp) continue;
    if (fp === pp) score += 220;
    else if (fp.endsWith(pp)) score += 140;
    else if (base === pathBase(pp).toLowerCase()) score += 120;
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
    ["collapse", "sidebar"],
    ["hover", "sidebar"],
    ["icon", "icon"],
  ];

  for (const [kw, segment] of keywords) {
    if (msg.includes(kw) && fp.includes(segment)) score += 16;
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

function pickFilesForPrompt(fileContext, cleanMsg, rememberedTargetFile, investigation, mode) {
  const files = Array.isArray(fileContext) ? fileContext.filter((f) => f && f.content) : [];
  const scored = files
    .map((f) => ({
      ...f,
      score: scoreFileForPrompt(f, cleanMsg, rememberedTargetFile, investigation),
    }))
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Set();

  const push = (file) => {
    if (!file?.path || seen.has(file.path)) return;
    seen.add(file.path);
    picked.push(file);
  };

  const priorityFiles = Array.isArray(investigation?.priorityFiles) ? investigation.priorityFiles : [];
  for (const p of priorityFiles) {
    const pp = String(p || "");
    const match = scored.find((f) => f.path === pp || f.path.endsWith(pp) || pathBase(f.path) === pathBase(pp));
    if (match) push(match);
  }

  if (rememberedTargetFile) {
    const rt = String(rememberedTargetFile);
    const match = scored.find((f) => f.path === rt || f.path.endsWith(rt) || pathBase(f.path) === pathBase(rt));
    if (match) push(match);
  }

  for (const f of scored) {
    if (picked.length >= MAX_PROMPT_FILES) break;
    push(f);
  }

  // Debug mode can use a bit more context, but we still keep it capped.
  return picked.slice(0, mode === "debug" ? Math.max(MAX_PROMPT_FILES, 6) : MAX_PROMPT_FILES);
}

// ── Design-token extraction (creative mode) ────────────────────────────────────
// "Go read the design files" told to the model produced flat template output; the
// tokens themselves in the prompt do not. Harvest the project's REAL visual language
// — colors, gradients, shadows, easings, custom animation classes — from globals.css
// and the in-context files, and inject them as ground truth for creative work.
async function extractDesignTokens(workspacePath, fileContext) {
  try {
    const sources = [];

    // globals.css: from context if loaded, else probe common locations
    const cssFromContext = (fileContext || []).find((f) => f?.path?.endsWith("globals.css"))?.content;
    if (cssFromContext) {
      sources.push(cssFromContext);
    } else if (workspacePath) {
      for (const candidate of ["app/globals.css", "src/app/globals.css", "chatbot/my-chatbot-ui/app/globals.css"]) {
        try {
          sources.push(await fs.readFile(path.resolve(workspacePath, candidate), "utf-8"));
          break;
        } catch { /* try next */ }
      }
    }
    for (const f of fileContext || []) {
      if (f?.content && /\.(tsx|jsx|css)$/.test(f.path || "")) sources.push(f.content);
    }
    if (sources.length === 0) return "";

    const all = sources.join("\n");
    const uniq = (arr, cap) => [...new Set(arr)].slice(0, cap);

    const colors    = uniq(all.match(/#[0-9a-fA-F]{6}\b/g) || [], 10);
    const gradients = uniq((all.match(/linear-gradient\([^)]{10,90}\)|radial-gradient\([^)]{10,90}\)/g) || []).map(g => g.replace(/\s+/g, " ")), 4);
    const shadows   = uniq(all.match(/shadow-\[[^\]]{10,80}\]|box-shadow:\s*[^;]{10,80}/g) || [], 4);
    const easings   = uniq(all.match(/\[0?\.\d+,\s*\d+(?:\.\d+)?,\s*0?\.\d+,\s*\d+(?:\.\d+)?\]|cubic-bezier\([^)]+\)/g) || [], 3);
    const cssClasses = uniq((sources[0] || "").match(/^\.[\w-]+(?=\s*\{)/gm) || [], 8);
    const surfaces  = uniq(all.match(/backdrop-blur-\w+|bg-white\/\[[\d.]+\]|border-white\/\[[\d.]+\]/g) || [], 6);

    const lines = [];
    if (colors.length)     lines.push(`Colors: ${colors.join(" ")}`);
    if (gradients.length)  lines.push(`Gradients: ${gradients.join(" | ")}`);
    if (shadows.length)    lines.push(`Shadows: ${shadows.join(" | ")}`);
    if (easings.length)    lines.push(`Easings: ${easings.join(" ")}`);
    if (surfaces.length)   lines.push(`Glass surfaces: ${surfaces.join(" ")}`);
    if (cssClasses.length) lines.push(`Custom CSS classes available: ${cssClasses.join(" ")}`);
    if (lines.length === 0) return "";

    return `\n## PROJECT DESIGN TOKENS (extracted from this codebase — use these, not generic values)\n${lines.join("\n")}`.slice(0, 1500);
  } catch {
    return "";
  }
}

// ── Design skills (Claude Code approach: curated expert packs, loaded on trigger) ──
// Skill files live in backend1/agents/skills/*.md with frontmatter `triggers:` —
// keyword-matched against the request, top 2 injected into the creative prompt.
// Users extend the agent by dropping their own .md files there (e.g. component
// recipes pasted from a library) — no code changes needed.
const SKILLS_DIR = path.join(__dirname, "..", "skills");

async function loadDesignSkills(cleanMsg, workspacePath) {
  try {
    const msg = String(cleanMsg || "").toLowerCase();
    const scored = [];
    const seen = new Set();

    // Two skill locations, mirroring Claude Code's built-in/project split:
    // the agent's own packs plus user-owned per-project packs in .kodo/skills.
    const dirs = [SKILLS_DIR];
    if (workspacePath) dirs.push(path.join(workspacePath, ".kodo", "skills"));

    for (const dir of dirs) {
      let entries = [];
      try { entries = await fs.readdir(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith(".md") || seen.has(name)) continue;
        seen.add(name);
        const raw = await fs.readFile(path.join(dir, name), "utf-8");
        const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
        const triggers = (fm?.[1].match(/triggers:\s*(.+)/)?.[1] || "")
          .split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
        const hits = triggers.filter((t) => msg.includes(t)).length;
        if (hits > 0) scored.push({ name, hits, body: raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim() });
      }
    }

    scored.sort((a, b) => b.hits - a.hits);
    const picked = scored.slice(0, 2);
    if (picked.length === 0) return "";

    console.log(`[PlanChanges] Design skills loaded: ${picked.map((p) => `${p.name}(${p.hits} triggers)`).join(", ")}`);
    return "\n\n" + picked.map((p) => p.body.slice(0, 4500)).join("\n\n");
  } catch {
    return "";
  }
}

// Optional per-mode model routing: creative work benefits from the strongest model
// the user has, surgical fixes don't need it. If settings.json defines
// "creativeModel", creative-mode planning uses it (same key/endpoint); everything
// else keeps the default route. Absent the setting, behavior is unchanged.
function resolveCreativeModelRoute(modelRoute, mode) {
  if (mode !== "creative") return modelRoute;
  try {
    const settingsPath = path.join(__dirname, "..", "..", "data", "settings.json");
    const settings = JSON.parse(readFileSyncSafe(settingsPath));
    if (settings?.creativeModel && typeof settings.creativeModel === "string") {
      console.log(`[PlanChanges] Creative mode → routing to creativeModel: ${settings.creativeModel}`);
      return { ...modelRoute, model: settings.creativeModel };
    }
  } catch { /* no settings / no field — keep default */ }
  return modelRoute;
}

function readFileSyncSafe(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "{}";
  }
}

function buildSystemPrompt({ rememberedTargetFile, lockToRemembered, mode, investigation, retryErrors = [], retryCount = 0, designTokens = "" }) {
  const focusRule = lockToRemembered && rememberedTargetFile
    ? `\nFOCUS: Edit ONLY "${rememberedTargetFile}". Do NOT touch unrelated files.\n`
    : "";

  const investigationSection = investigation
    ? `
## DEBUG INVESTIGATION CONTEXT
Root cause: ${investigation.likelyRootCause || "unknown"}
Confidence: ${typeof investigation.confidence === "number" ? investigation.confidence : "unknown"}
Evidence:
${Array.isArray(investigation.evidence) ? investigation.evidence.map((e) => `- ${e}`).join("\n") : "- none"}

Hypotheses:
${Array.isArray(investigation.hypotheses) ? investigation.hypotheses.map((h) => `- ${h}`).join("\n") : "- none"}

Priority files:
${Array.isArray(investigation.priorityFiles) ? investigation.priorityFiles.map((p) => `- ${p}`).join("\n") : "- none"}

Next checks:
${Array.isArray(investigation.nextChecks) ? investigation.nextChecks.map((n) => `- ${n}`).join("\n") : "- none"}
`
    : "";

  const modeSection = {
    creative: `
## CREATIVE MODE — craft checklist (all of these, every time)
Design like the senior designer of THIS product, not a template generator:
1. USE THE PROJECT'S REAL TOKENS. Reuse the exact colors, gradients, shadows, and easings from the design-token list and reference files below — never substitute a flat solid color where the product uses a gradient.
2. DEPTH: layered backgrounds (radial/linear gradient washes, blurred glow orbs), glassmorphism surfaces (backdrop-blur + translucent bg + border-white/[0.06]), soft colored shadows — not flat rectangles.
3. MOTION: staggered entrances (staggerChildren), spring or cubic-bezier easing like [0.22, 1, 0.36, 1], whileInView reveals for below-the-fold sections, hover micro-interactions on every interactive element.
4. STRUCTURE: define repeated UI as a data array + one mapped component — NEVER paste the same JSX block 2+ times with different text. Extract a local component when an element has behavior (handlers, state).
5. COPY IS SACRED: when the user supplies exact text (headlines, labels, button copy), use it VERBATIM — never rewrite, shorten, or "improve" their words.
6. NAMED TECHNIQUES ARE CONTRACTS: if the request names an API or technique (useScroll, useTransform, sticky pinning, scroll-jacking, whileInView), your patch MUST actually use it. Never silently substitute a simpler pattern (e.g. overflow-x-auto is NOT scroll-jacking). If you truly cannot implement it, say so in a read_only step instead of shipping a lookalike.
${designTokens}`,

    debug: `
## DEBUG MODE
The user reported an error or bug. Fix the root cause, not the symptom.

THINK IN LAYERS before writing the plan:
1. CONTRACT layer — does the client send what the server expects (method, headers, body, path)?
2. HANDLER layer — does the server route/handler parse and process it correctly?
3. SERVICE layer — does the service function use only symbols it actually imports?
4. STATE layer — does the UI reflect the server response correctly?

Fix the LOWEST broken layer first. Do not add workarounds on top of a broken foundation.
If the investigation says the backend is rejecting the request, fix the request/contract mismatch.
If a service function references an undefined variable, fix the import — do not rewrite callers.
You may edit multiple files when the bug spans layers (e.g. frontend header + backend parser).`,

    lint: `
## LINT FIX MODE
Fix ONLY the specific lint/type errors. Preserve every line of logic, every component, every import that is not directly causing the error.

STRICT RULES:
- NEVER use rewrite_file — it destroys code. Use replace_text or replace_block only.
- ONE patch per lint violation. Touch only the exact line(s) reported.
- no-explicit-any → replace \`any\` with \`unknown\`, a proper interface, or a narrower type. Do NOT remove the variable or the block it lives in.
- no-unused-vars / no-unused-imports → remove only that one declaration/import. Keep everything else.
- prefer-const → change \`let\` to \`const\` on that one line only.
- If fixing an \`any\` type requires knowing the shape, use \`unknown\` and add \`as unknown\` cast rather than removing code.
- Do NOT delete functions, components, hooks, handlers, or any business logic.
- Do NOT restructure, reformat, or reorder code.`,

    surgical: `
## SURGICAL MODE
Do exactly what was asked — nothing more, nothing less.
- Touch ONLY the code the user explicitly mentioned.
- If the user says "change button X in sidebar", find button X's JSX block and change ONLY those lines. Leave every other button, icon, state variable, and handler byte-for-byte identical.
- Do NOT add new state, hooks, imports, or helper functions unless the user asked for them.
- Do NOT restructure, reformat, or reorder surrounding code.`,

    multi: `
## MULTI-TASK MODE
The user requested several distinct changes. Apply EVERY one of them — do not skip any.

RULES:
1. Identify each individual task from the user's request.
2. Produce one plan step per task (or per file if tasks span multiple files).
3. ALL tasks must appear as steps in the "plan" array — never collapse them into one step.
4. Each patch must be surgical: use replace_block or replace_text, never rewrite_file unless a task is truly file-wide.
5. Do NOT add unrequested changes alongside the requested ones.`,

    scoped: `
## SCOPED ELEMENT MODE
The user asked to change a specific named element (button, icon, text, color, etc.) inside a larger component.

RULES — read carefully:
1. Identify the EXACT element the user named. Do not assume adjacent elements also need changes.
2. Your patch must match ONLY that element's JSX block. Use the shortest unique anchor.
3. Do NOT use rewrite_file — it would destroy all surrounding code. Use replace_block or replace_text.
4. Do NOT touch any other element in the same file — other buttons, icons, state variables, handlers, imports must remain byte-for-byte identical.
5. If you find you need to change two elements to satisfy the request, add TWO separate patches — not a rewrite.`,
  };

  // Escalate to rewrite_file on the FIRST retry, not after two failures.
  // retryErrors is rebuilt fresh each call so it never accumulates to >=2.
  // One failed surgical patch is enough signal — use the full file on retry.
  const hasMultipleRetries = retryCount >= 1;
  const retrySection = retryErrors.length > 0
    ? `
⚠️ RETRY — PREVIOUS ATTEMPT FAILED
The last patch was rejected for the following reason(s):
${retryErrors.map(e => `  • ${e}`).join("\n")}

${hasMultipleRetries
  ? `ESCALATE TO REWRITE: A surgical patch already failed. For this retry, use rewrite_file with the COMPLETE, CORRECTLY MODIFIED file content. Do NOT use replace_block or replace_text — the search anchor did not match. Write the ENTIRE file from scratch with the change correctly applied.`
  : `Do NOT repeat the same patch. Generate a DIFFERENT, CORRECT patch that avoids these errors.\nFor JSX/TSX files: mentally trace the tag structure of your patch before outputting it.`}
`
    : "";

  return `You are Kodo, a surgical AI code editor.
${focusRule}${retrySection}${investigationSection}${modeSection[mode] || modeSection.surgical}

JSX/TSX VALIDITY RULES (always enforced)
- Every JSX attribute MUST be inside its element's opening tag. Never leave props floating outside a tag.
- All tags must be balanced: every <Foo> must have </Foo> or be self-closed <Foo />.
- A JSX expression returns exactly one root element. Use a fragment (<> </>) if you need siblings.
- When adding a sibling element inside a ternary branch (e.g. adding a button below a div inside "condition ? (DIV) : …"), wrap the whole true-branch in a React fragment so it has one root: "condition ? (Fragment DIV BUTTON /Fragment) : …".
- After applying your patch, mentally re-read the resulting JSX to confirm it is valid.
- If your patch adds new JSX elements, confirm existing closing tags are still present.
- Event handlers in TSX must type their event parameter: onPointerMove={(e: React.PointerEvent<HTMLDivElement>) => ...}. An untyped "e" makes e.currentTarget an EventTarget with no .style — a guaranteed typecheck failure. Never call .style/.getBoundingClientRect on an untyped event target.
- Escape apostrophes in JSX text as &apos; or &rsquo; ("it's" → "it&apos;s") — react/no-unescaped-entities is enforced in this project.
- Never write a bare > or < character inside JSX text content (e.g. arrows like "->" or "Learn more >"): use {'>'} / {'<'} or &gt; / &lt; — a bare one is a parse error.

FIDELITY RULES (always enforced)
- User-supplied text is VERBATIM: headlines, labels, button copy, descriptions the user wrote must appear byte-for-byte. Never paraphrase them.
- Named techniques are contracts: if the request names an API (useScroll, useTransform, useSpring, whileInView) or a technique (scroll-jacking, sticky pinning, 3D tilt), the patch must genuinely use it — no simpler lookalikes.
- Requested link targets are exact: "links to /" means href="/", "anchor links to #security" means href="#security" — never placeholder href="#".

DEPENDENCY RULES
- ALWAYS use the EXACT file path shown in "### File: <path>" headers below. Never abbreviate.
- If an error trace says "app/lib/api.ts" but the file is shown as "chatbot/my-chatbot-ui/app/lib/api.ts", use the full path.
- Before emitting a plan step, verify the path appears in the file list below.
- If you need to edit a file NOT in the list, emit a read_only step explaining what you need.

OUTPUT FORMAT
Return ONLY valid JSON. Two forms are allowed:

Form A — normal plan (you have enough context):
{
  "reasoning": "Root cause in one sentence. Which layer is broken and why.",
  "dependencyNotes": "Which files call which, and why editing X requires or does not require editing Y.",
  "plan": [
    {
      "action": "edit | create | delete | read_only",
      "path": "exact/path/from/file/list",
      "description": "what changed and why",
      "patches": [
        {
          "kind": "rewrite_file | replace_text | replace_block | insert_before | insert_after | delete_text",
          "search": "unique text or anchor",
          "replace": "replacement text",
          "content": "full file content for rewrite_file"
        }
      ]
    }
  ]
}

Form B — request more context (file is truncated and you need a specific section):
{
  "reasoning": "Why you need more lines.",
  "plan": [],
  "read_more": [
    { "path": "exact/path/from/file/list", "around": "short keyword or code phrase that appears near the section you need" }
  ]
}
Use Form B ONLY when the file shown is explicitly truncated (contains "[file continues]" or "[truncated]") AND you cannot make a correct patch without seeing the missing section. The system will load the requested section and retry.

PATCH RULES
- Use the EXACT path from the "### File: <path>" header — never shorten it.
- DEFAULT: use replace_block for any targeted element change (a button, an icon, a className, a prop value).
- Use replace_text for single-line changes (a string, a class, a prop on one line).
- Use insert_before / insert_after for purely additive changes (adding an import, a new element).
- Use rewrite_file ONLY when the change touches the MAJORITY of the file or the user explicitly says "rewrite" / "replace the whole file". NEVER use rewrite_file to change one element inside a multi-element component.
- Use the SHORTEST unique anchor that safely locates the target — 2–5 lines is usually enough.
- Never include line numbers in search/replace text.
- Never include markdown fences.
- For JSX, keep all tags balanced — every opened tag must be closed.
- CRITICAL JSON RULE: "search" and "replace" values are JSON strings. Double-quotes inside them MUST be escaped as \\". For example: "search": "<div className=\\"flex items-center\\">" — never use raw unescaped " inside a JSON string value.

CSS LAYOUT RULES (Tailwind / absolute positioning)
- An \`absolute\` element sizes relative to its nearest \`relative\` ancestor — NOT to the page.
- When the task is "make a vertical line span all list items": the line must be \`absolute\` inside the CONTENT container (the div that grows with items), NOT inside a scroll wrapper (a div with \`overflow-y-auto\` or \`max-h-*\`). If the line currently sits inside the scroll wrapper: (1) remove \`relative\` from the scroll wrapper, (2) add \`relative\` to the inner items div, (3) move the line element inside that inner div, AND (4) set the line to \`top-0 bottom-0\` so it spans the full content height. All four changes must be in the same patch.
- A scroll container with \`max-h-[320px]\` is only 320 px tall in the viewport. An \`absolute top-0 bottom-0\` line inside it will never be taller than 320 px no matter how many items exist. After moving \`relative\` to the items container, also update any \`top-X bottom-X\` values on the line to \`top-0 bottom-0\` so it spans actual content height.
- For hover-only UI (copy buttons, action overlays): add \`group\` to the wrapper, then \`opacity-0 group-hover:opacity-100\` to the action element — no JS state needed.

If you cannot confidently fix the issue, return a read_only step explaining the exact blocker.`;
}

function buildUserPrompt(userMessage, fileContext, rememberedTargetFile, lockToRemembered, mode, investigation, retryErrors = [], maxFileChars = MAX_FILE_CHARS, totalContextChars = MAX_TOTAL_CONTEXT_CHARS) {
  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();

  const filesToShow = pickFilesForPrompt(fileContext, cleanMsg, rememberedTargetFile, investigation, mode);

  const fileSnippets = [];
  let totalChars = 0;

  // Multi mode: keep each file small so the combined input doesn't eat the model's
  // output budget. gapgpt-qwen-3.6 has ~8192 total tokens; with 2 files at 10k chars
  // each the input alone uses ~6k tokens and the JSON plan gets truncated mid-write.
  // 5000 chars per file leaves ~4000 tokens for the plan output (enough for 2 patches).
  //
  // Reference-copy mode ("make File B look like File A") needs BOTH files' real
  // content, not a keyword-windowed guess: shortenContentSmart's window picker
  // scores by keyword density per line, and generic Tailwind/JSX boilerplate near
  // the top of a file (many className/style/icon-bearing lines) can out-score the
  // one real target block, landing the window on the wrong section entirely — this
  // was verified empirically against real files, not a theoretical concern. Rather
  // than trust windowing, give both files enough budget to show in full (most
  // React components are well under 22k chars) — same "always show full content"
  // approach already used for multi-mode's sequential single-file planner below.
  //
  // maxFileChars/totalContextChars come from resolveContextBudget(modelRoute) — scaled
  // to the ACTIVE model's real context window instead of one flat constant for every
  // model. 46000/22000 are floors verified against real files for small/unknown models;
  // a model with a larger resolved budget gets more, never less.
  const referenceCopy = isReferenceCopyRequest(cleanMsg);
  const totalBudget = referenceCopy ? Math.max(totalContextChars, 46000) : totalContextChars;
  const perFileBudget = mode === "multi" ? 5000
    : referenceCopy ? Math.max(maxFileChars, 22000)
    : maxFileChars;

  for (const f of filesToShow) {
    const outline = buildJsxOutline(f.content, f.path);
    const numbered = addLineNumbers(shortenContentSmart(f.content, perFileBudget, cleanMsg));
    const summary = f.summary ? `\nSummary: ${f.summary}` : "";
    const block = `### File: ${f.path}${summary}${outline}\n\`\`\`\n${numbered}\n\`\`\``;

    if (totalChars + block.length > totalBudget && fileSnippets.length > 0) break;
    totalChars += block.length;
    fileSnippets.push(block);
  }

  const focusNote = !lockToRemembered || mode === "debug"
    ? ""
    : `\n\nEdit ONLY "${rememberedTargetFile}".`;

  const investigationNote = investigation
    ? `\nInvestigation says likely root cause: ${investigation.likelyRootCause || "unknown"}`
    : "";

  const instructions = {
    lint: "Fix ONLY the exact lint violations. Use replace_text per violation. NEVER use rewrite_file. Keep all logic, components, and imports that are not directly causing the error.",
    creative: "Be bold but controlled. Improve the design and clarity where it helps. Prefer replace_block over rewrite_file unless the change is truly file-wide.",
    debug: "Use the investigation evidence to fix the root cause. Do not edit blindly.",
    scoped: "The user referenced a specific element. If it exists, use replace_block or replace_text to change ONLY that element. If it does not exist yet, use insert_after to add it in the correct position. NEVER use rewrite_file. Leave all surrounding code untouched.",
    surgical: "Make the MINIMUM change to fulfill the request. When moving an element to a new location, restructure the immediate parent section as needed — add a React fragment wrapper, remove the element from its current position, and insert it in the new position — all in a single replace_block patch. Every other line must remain identical.",
    multi: "The user requested MULTIPLE changes. Produce one edit step per task — every task gets an EDIT action, not read_only. NEVER mark a file read_only just because you are unsure; if the file is shown below, you have enough context to edit it. Use replace_block or replace_text per task.",
  };

  const retryNote = retryErrors.length > 0
    ? `\n\n⚠️ RETRY: Previous patch failed — ${retryErrors.slice(0, 2).join(" | ")}. Generate a DIFFERENT correct patch.`
    : "";

  // In multi mode, list every available file upfront so the model can't claim
  // a file is "not provided" when it is clearly in the snippets below.
  const availableFilesNote = mode === "multi" && fileSnippets.length > 1
    ? `\nAVAILABLE FILES (all ${fileSnippets.length} must have an edit step):\n${
        fileSnippets.map((_, i) => {
          const header = filesToShow[i]?.path ?? "?";
          return `  [${i + 1}] ${header}`;
        }).join("\n")
      }\nNever write "file content was not provided" for any file listed above — the content IS present in the "### File:" blocks below.\n`
    : "";

  return `User request: "${cleanMsg}"${focusNote}${investigationNote}${retryNote}
${availableFilesNote}
${instructions[mode] || instructions.surgical}

CRITICAL: Use each file's EXACT path as shown in the "### File: <path>" header.
If an error trace mentions "app/lib/api.ts" but the file header shows "chatbot/my-chatbot-ui/app/lib/api.ts", use the full path in your plan.

Use the shortest unique anchor possible. Do NOT use rewrite_file unless the change is genuinely file-wide.
If a file is not shown below, do not invent its contents — emit a read_only step instead.

${fileSnippets.length ? `Project files:\n\n${fileSnippets.join("\n\n")}` : "No files found."}

Return ONLY valid JSON.`;
}

function repairJSON(text) {
  // LLMs often embed literal newlines/tabs inside JSON strings, AND forget to escape
  // double-quotes that appear inside JSX attribute values (className="foo", href="...", etc.).
  //
  // Strategy for unescaped quotes: a `"` that genuinely closes a JSON string is always
  // followed by a JSON structural character (, } ] or newline/end-of-input).
  // A `"` followed by anything else (letters, =, /, >) is JSX content — escape it.
  let result = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      result += ch;
      escape = false;
    } else if (ch === "\\" && inString) {
      result += ch;
      escape = true;
    } else if (ch === '"') {
      if (!inString) {
        result += ch;
        inString = true;
      } else {
        // Peek ahead (skip spaces, NOT newlines) to decide if this closes the string.
        let j = i + 1;
        while (j < text.length && text[j] === " ") j++;
        const next = j < text.length ? text[j] : "\0";
        const isStructural =
          next === "," || next === "}" || next === "]" ||
          next === "\n" || next === "\r" || next === "\0" || next === ":";
        if (isStructural) {
          result += ch;
          inString = false;
        } else {
          // Unescaped quote inside JSX content — escape it.
          result += '\\"';
        }
      }
    } else if (inString && ch === "\n") {
      result += "\\n";
    } else if (inString && ch === "\r") {
      result += "\\r";
    } else if (inString && ch === "\t") {
      result += "\\t";
    } else {
      result += ch;
    }
  }
  return result;
}

function extractJSON(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Candidates to try in order: strip fences, try raw, try each embedded block
  const candidates = [];

  // 1. Strip outermost code fence if present
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  candidates.push(stripped);

  // 2. Extract any ```json ... ``` block embedded in prose
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());

  // 3. Fall back to the raw text as-is
  candidates.push(raw);

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) continue;
    const slice = candidate.slice(start, end + 1);

    // First try direct parse
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try with repaired text
    }

    // Repair literal control characters inside strings and retry
    try {
      const parsed = JSON.parse(repairJSON(slice));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try next candidate
    }
  }

  return null;
}

function stripLineNumbers(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\s*\|\s?/, ""))
    .join("\n");
}

const PATCH_KIND_ALIASES = {
  replace:        "replace_text",
  replace_string: "replace_text",
  str_replace:    "replace_text",
  block_replace:  "replace_block",
  rewrite:        "rewrite_file",
  overwrite:      "rewrite_file",
  full_rewrite:   "rewrite_file",
  insert:         "insert_after",
  prepend:        "insert_before",
  delete:         "delete_text",
  remove:         "delete_text",
};

function normalizePatchKind(raw) {
  const k = String(raw || "").trim().toLowerCase();
  return PATCH_KIND_ALIASES[k] || k;
}

function normalizePatchList(item) {
  const out = [];

  const patches = Array.isArray(item?.patches) ? item.patches : [];
  for (const p of patches) {
    if (!p || typeof p !== "object") continue;
    const kind = normalizePatchKind(p.kind || p.type || "");
    if (!kind) continue;

    out.push({
      kind,
      search: stripLineNumbers(p.search || p.anchor || p.before || ""),
      replace: stripLineNumbers(p.replace || p.content || p.after || ""),
      content: stripLineNumbers(p.content || ""),
      anchor: stripLineNumbers(p.anchor || ""),
      before: stripLineNumbers(p.before || ""),
      after: stripLineNumbers(p.after || ""),
    });
  }

  if (Array.isArray(item?.edits)) {
    for (const e of item.edits) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.search !== "string" || typeof e.replace !== "string") continue;
      out.push({
        kind: "replace_text",
        search: stripLineNumbers(e.search),
        replace: stripLineNumbers(e.replace),
        content: "",
        anchor: "",
        before: "",
        after: "",
      });
    }
  }

  return out;
}

function canonicalizePlanPath(plannedPath, fileContext, rememberedTargetFile) {
  const raw = String(plannedPath || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw) return raw;

  const files = Array.isArray(fileContext) ? fileContext : [];

  const exact = files.find((f) => f?.path === raw);
  if (exact) return exact.path;

  const remembered = String(rememberedTargetFile || "").trim().replace(/\\/g, "/");
  if (remembered) {
    const byRemembered = files.find(
      (f) => f?.path === remembered || f?.path.endsWith(remembered) || remembered.endsWith(f?.path || "")
    );
    if (byRemembered && (raw === pathBase(byRemembered.path) || byRemembered.path.endsWith(raw) || raw.endsWith(pathBase(byRemembered.path)))) {
      return byRemembered.path;
    }
  }

  const base = pathBase(raw);
  const byBase = files.find((f) => pathBase(f?.path) === base);
  if (byBase) return byBase.path;

  const byEnd = files.find((f) => {
    const fp = String(f?.path || "");
    return fp.endsWith(raw) || raw.endsWith(fp);
  });
  if (byEnd) return byEnd.path;

  return raw;
}

function applyPathCanonicalization(plan, fileContext, rememberedTargetFile) {
  return (plan || []).map((item) => {
    if (!item?.path) return item;

    // "create" targets a NEW file by definition. canonicalizePlanPath's byBase/byEnd
    // fallbacks exist to fix an EDIT step whose path is slightly off from an already-
    // loaded file — for a create step they instead silently redirect the write onto
    // an unrelated existing file that happens to share the same filename (observed:
    // a request to create "landing2/page.tsx" got snapped onto the already-loaded
    // "landing/page.tsx" and overwrote the real page with a stub). Only normalize
    // slashes for creates — never fuzzy-match onto an existing path.
    if (item.action === "create") {
      return { ...item, path: String(item.path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "") };
    }

    return {
      ...item,
      path: canonicalizePlanPath(item.path, fileContext, rememberedTargetFile),
    };
  });
}

// A single plan can contain multiple "edit" steps for the same file (multi-task mode
// especially). All patches in a plan are generated in one shot against the same
// pre-execution file snapshot — if two separate steps both target regions of the same
// file, the second step's search anchor can already be stale by the time execute_changes
// gets to it (the first step's patch may have shifted or rewritten that exact text).
// execute_changes.mjs already applies multiple patches WITHIN one step cumulatively
// (each patch's output feeds the next), so merging same-path edit steps into one step
// makes every same-file edit go through that same safe, sequential path instead of two
// independently-applied steps racing against a snapshot that's stale by step two.
function mergeSameFileEditSteps(plan) {
  const merged = [];
  const editIndexByPath = new Map();

  for (const step of plan || []) {
    if (step.action === "edit" && step.path && editIndexByPath.has(step.path)) {
      const target = merged[editIndexByPath.get(step.path)];
      target.patches.push(...(step.patches || []));
      target.edits.push(...(step.edits || []));
      target.description = target.description
        ? `${target.description}; ${step.description}`
        : step.description;
      continue;
    }

    if (step.action === "edit" && step.path) {
      editIndexByPath.set(step.path, merged.length);
    }
    merged.push(step);
  }

  return merged;
}



// Build a focused single-file user prompt for the sequential planner.
// Claude Code approach: always show the file HEADER (imports + hook declarations)
// plus a focused body window around the relevant change location.
// This lets the planner see both where to declare a new ref/state AND where to use it.
const MAX_SINGLE_FILE_CHARS = 12_000;
const HEAD_LINES = 60; // enough to capture all imports + useState/useRef declarations

function buildSingleFilePrompt(userMessage, file, focusInstruction) {
  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();
  const content = String(file.content || "");
  const outline = buildJsxOutline(content, file.path);

  let displayContent;
  if (content.length > MAX_SINGLE_FILE_CHARS) {
    const lines = content.split("\n");
    const head = lines.slice(0, HEAD_LINES).join("\n");
    const bodyLines = lines.slice(HEAD_LINES).join("\n");
    const bodyBudget = MAX_SINGLE_FILE_CHARS - head.length - 60; // 60 chars for separator

    if (bodyBudget > 1500) {
      // Focused body: find the most relevant section AFTER the header
      const focusedBody = shortenContentSmart(bodyLines, bodyBudget, `${cleanMsg} ${focusInstruction}`);
      displayContent = `${head}\n\n// ── [file continues — focused section below] ──\n\n${focusedBody}`;
    } else {
      // Header alone already fills the budget — just show it with smart truncation
      displayContent = shortenContentSmart(content, MAX_SINGLE_FILE_CHARS, `${cleanMsg} ${focusInstruction}`);
    }
  } else {
    displayContent = content;
  }

  const numbered = addLineNumbers(displayContent);
  const summary = file.summary ? `\nSummary: ${file.summary}` : "";

  return `User request: "${cleanMsg}"

${focusInstruction}

IMPORTANT: The file is shown in two parts — a HEADER (top ${HEAD_LINES} lines with imports and hook declarations) and a focused BODY section. You may need to add patches in BOTH parts. For example:
- If you must declare a new variable (useRef, useState, const), add an insert_after patch in the HEADER section near similar declarations.
- If you must use that variable later, add a replace_block patch in the BODY section.
Both patches go into the same plan step (same "patches" array).

Use replace_block or replace_text for surgical changes.
Use the SHORTEST unique anchor (2-5 lines). Never include line numbers or markdown fences in search/replace text.
For JSX: every opened tag must be closed.

Project files:

### File: ${file.path}${summary}${outline}
\`\`\`
${numbered}
\`\`\`

Return ONLY valid JSON (same schema as always: { reasoning, dependencyNotes, plan: [...] }).`;
}

// Plan each file independently (Claude Code approach): one LLM call per file,
// full content each time. Combines results into a single plan array.
async function planFilesSequentially({ filesToShow, userMessage, system, modelRoute, investigation }) {
  const combined = [];

  for (const file of filesToShow.slice(0, 4)) {
    const baseName = file.path.split("/").pop();
    const instruction = `Edit ONLY "${file.path}". Apply the part of the user request that relates to this file. Do NOT reference or touch any other file. Do NOT emit read_only for this file — its full content is provided below.`;

    const content = buildSingleFilePrompt(userMessage, file, instruction);

    let result;
    try {
      result = await generatePlanWithRetry({ system, content, modelRoute, mode: "single_file" });
    } catch (e) {
      console.warn(`[PlanChanges] Sequential plan failed for ${baseName}: ${e.message}`);
      continue;
    }

    if (result.parsed?.plan) {
      const steps = result.parsed.plan.filter(s => s.action !== "read_only" || combined.length === 0);
      combined.push(...steps);
      console.log(`[PlanChanges] Sequential[${baseName}]: ${steps.length} step(s)`);
    }
  }

  return combined.length > 0 ? { plan: combined } : null;
}

async function generatePlanWithRetry({ system, content, modelRoute, mode = "surgical", emit }) {
  let lastError = null;
  let rawResponse = "";

  // Keep maxOut consistent across attempts so the retry isn't token-starved.
  // single_file prompts are smaller (one full file) so 4096 is plenty.
  // Creative requests (new sections, animations) produce the LARGEST patches —
  // 100+ lines of JSX escaped inside JSON easily blows past 6000 output tokens
  // and truncates mid-JSON, which parses as "no usable plan". Give them headroom.
  const maxOut = (mode === "single_file") ? 4096 : (mode === "creative") ? 9000 : 6000;

  // Heartbeat: slow LLM providers can take 1-3 min for a large planning prompt.
  // Send a progress tick every 15s so the UI shows the agent is alive, not stuck.
  let secondsWaiting = 0;
  const heartbeat = emit
    ? setInterval(() => {
        secondsWaiting += 15;
        emit({ type: "progress", stage: "planning", message: `Still designing... (${secondsWaiting}s)` });
      }, 15_000)
    : null;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callLLM({
          system,
          messages: [{ role: "user", content }],
          modelRoute,
          maxTokens: maxOut, // same on both attempts — don't starve the retry
          temperature: 0,
          stream: true,
        });

        rawResponse = result?.content || "";
        if (!rawResponse.trim() && attempt === 0) {
          // Empty response on first attempt — retry once
          await delay(600);
          continue;
        }
        return { rawResponse, parsed: extractJSON(rawResponse), error: null };
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err || "");
        const isTransient = /504|502|503|gateway timeout|timeout|ETIMEDOUT|ECONNRESET|network|rate limit/i.test(msg);

        if (attempt === 0 && isTransient) {
          await delay(800);
          continue;
        }
        break;
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  return { rawResponse, parsed: null, error: lastError };
}

// When the structured-JSON plan fails, fall back to what Claude Code does natively:
// the model writes CODE, not code-inside-JSON. Large creative additions (a whole
// landing-page section is 100+ lines of JSX) reliably break the JSON path — the
// output truncates mid-string or the escaping collapses — while the same model
// produces the same code flawlessly as a plain fenced block. Ask for the complete
// updated file and construct the rewrite plan programmatically.
async function generateFullFileRewritePlan({ cleanMsg, file, modelRoute, emit, extraGuidance = "" }) {
  try {
    emit?.({ type: "progress", stage: "planning", message: "Structured plan failed — regenerating as direct code..." });

    const content = String(file.content || "");
    // Output budget sized to the file: the response must hold the ENTIRE updated
    // file plus additions — and a ground-up redesign can be much LARGER than the
    // original, so the floor is generous. ~3 chars/token for code.
    const maxTokens = Math.min(16_000, Math.max(9000, Math.ceil(content.length / 3) + 3000));

    const result = await callLLM({
      system: `You are Kodo, an expert AI code editor. You will receive a user request and the full current content of one file. Apply the request and return the COMPLETE UPDATED FILE.

STRICT OUTPUT RULES:
- Output ONLY the updated file content inside ONE \`\`\`tsx code fence.
- No JSON. No explanations before or after the fence.
- Include EVERY line of the final file — never truncate, never write placeholders like "// rest of the file unchanged".
- Keep all existing code the request does not ask to change, byte-for-byte.${extraGuidance ? `\n\nDESIGN GUIDANCE (follow when the request is visual):${extraGuidance}` : ""}`,
      messages: [{
        role: "user",
        content: `Request: "${cleanMsg}"\n\nCurrent content of ${file.path}:\n\`\`\`tsx\n${content}\n\`\`\`\n\nReturn the complete updated file now.`,
      }],
      modelRoute,
      maxTokens,
      temperature: 0,
      stream: true,
    });

    const raw = String(result?.content || "");
    if (!raw.trim()) return null;

    const fence = raw.match(/```(?:tsx|typescript|jsx|javascript|ts|js)?\s*\n([\s\S]*?)```/);
    let code = fence ? fence[1] : null;
    if (!code) {
      // Model skipped the fence but output looks like the file itself — accept it.
      const trimmed = raw.trim();
      if (/^(["']use client["']|import\s)/.test(trimmed)) code = trimmed;
    }
    if (!code) return null;

    code = code.trim();
    // Sanity: must be a real full file, not just a fragment, and at least half the
    // original size. Export check matches the ORIGINAL file's style — requiring
    // "export default" unconditionally rejected every legitimate rewrite of a
    // named-export-only component (e.g. `export function CinematicFooter()`),
    // which guaranteed failure on every single request touching that file.
    const originalHasDefault = /export\s+default/.test(content);
    const outputHasDefault = /export\s+default/.test(code);
    const outputHasAnyExport = /export\s+(default|const|function|class|type|interface|\{)/.test(code);
    const exportOk = originalHasDefault ? outputHasDefault : outputHasAnyExport;

    if (!exportOk || code.length < content.length * 0.5) {
      console.warn(`[PlanChanges] Full-file fallback rejected: ${code.length} chars vs original ${content.length}, exportOk=${exportOk} (originalHasDefault=${originalHasDefault})`);
      return null;
    }

    console.log(`[PlanChanges] Full-file fallback produced ${code.length} chars for ${file.path}`);
    return {
      reasoning: "Structured JSON plan was unusable; regenerated the change as a complete updated file.",
      dependencyNotes: "",
      plan: [{
        action: "edit",
        path: file.path,
        description: "Applied the request as a full-file update (structured plan fallback)",
        patches: [{ kind: "rewrite_file", content: code, search: "", replace: "", anchor: "", before: "", after: "" }],
      }],
    };
  } catch (err) {
    console.warn("[PlanChanges] Full-file fallback failed:", String(err?.message || err).slice(0, 150));
    return null;
  }
}

// Explicit paths in the message that do NOT exist on disk are files the user wants
// CREATED. The JSON plan path reliably dies on large creations (a 14KB component
// inside a JSON string truncates or breaks escaping), and the full-file EDIT
// fallback can't help — it rewrites an existing file. This detector feeds the
// create-specific raw-code fallback below.
async function detectCreateTargets(cleanMsg, workspacePath, fileContext) {
  const targets = [];
  const re = /\b([\w.-]+(?:\/[\w.-]+)+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json))\b/gi;
  const inContext = new Set((fileContext || []).map((f) => f?.path));
  for (const m of String(cleanMsg || "").matchAll(re)) {
    const p = m[1].replace(/^@/, "");
    if (inContext.has(p) || targets.includes(p)) continue;
    try {
      await fs.access(path.resolve(workspacePath || PC_PROJECT_ROOT, p));
    } catch {
      targets.push(p);
    }
  }
  return targets.slice(0, 2);
}

// Raw-code fallback for CREATE tasks: ask for the complete new file in a fence —
// no JSON — and build the create step programmatically. If the user's message
// includes source code to adapt (the 21st.dev workflow), the model applies the
// adaptation instructions to it directly.
async function generateNewFilePlan({ cleanMsg, newPath, modelRoute, emit, extraGuidance = "" }) {
  try {
    emit?.({ type: "progress", stage: "planning", message: `Structured plan failed — generating ${path.basename(newPath)} as direct code...` });

    const result = await callLLM({
      system: `You are Kodo, an expert AI engineer. The user wants a NEW file created at: ${newPath}

Produce the COMPLETE content of that new file according to the user's request. If the request includes source code to adapt, apply EVERY adaptation instruction to it faithfully — renames, replaced classes, removed imports, rebranded text — and keep everything else exactly as provided.

STRICT OUTPUT RULES:
- Output ONLY the new file's content inside ONE code fence.
- No JSON. No explanations before or after the fence.
- The file must be complete and self-contained — never truncate, never write placeholders like "// rest of the code".${extraGuidance ? `\n\nDESIGN GUIDANCE (follow when the request is visual):${extraGuidance}` : ""}`,
      messages: [{ role: "user", content: cleanMsg }],
      modelRoute,
      maxTokens: 12_000,
      temperature: 0,
      stream: true,
    });

    const raw = String(result?.content || "");
    const fence = raw.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
    let code = fence ? fence[1].trim() : null;
    if (!code && /^(["']use client["']|import\s|\/\/|\/\*)/.test(raw.trim())) code = raw.trim();
    // A real module, not a fragment: some export (named exports are fine —
    // components like CinematicFooter export by name, not default).
    if (!code || code.length < 400 || !/export\s+(default|const|function|class|type|interface|\{)/.test(code)) {
      console.warn(`[PlanChanges] New-file fallback rejected for ${newPath}: ${code ? code.length : 0} chars, hasExport=${code ? /export\s/.test(code) : false}`);
      return null;
    }

    console.log(`[PlanChanges] New-file fallback produced ${code.length} chars for ${newPath}`);
    return {
      action: "create",
      path: newPath,
      description: `Created ${newPath} (raw-code fallback after structured plan failure)`,
      patches: [],
      edits: [],
      content: code,
    };
  } catch (err) {
    console.warn("[PlanChanges] New-file fallback failed:", String(err?.message || err).slice(0, 150));
    return null;
  }
}

function buildFallbackPlan({ fileContext, rememberedTargetFile, mode, emptyResponse = false }) {
  const files = Array.isArray(fileContext) ? fileContext.filter((f) => f?.path) : [];
  const target =
    files.find((f) => f.path === rememberedTargetFile) ||
    files.find((f) => rememberedTargetFile && (f.path.endsWith(rememberedTargetFile) || rememberedTargetFile.endsWith(f.path))) ||
    files[0] ||
    null;

  if (!target) {
    return {
      reasoning: "Could not generate a plan because no usable file context was available.",
      dependencyNotes: "Need file context for the target file to produce a safe edit plan.",
      plan: [
        {
          action: "read_only",
          path: "",
          description: "No usable file context was available for planning.",
          patches: [],
        },
      ],
    };
  }

  // These read_only descriptions surface directly in the chat as the final answer
  // (verify.mjs copies them into summaryLines) — write them for the USER, not for
  // internal debugging. Say plainly: nothing was changed, here's the likely cause,
  // here's what to do.
  if (mode === "debug") {
    return {
      reasoning: "The planner timed out, so the safest fallback is to inspect the target file and the files directly related to the request.",
      dependencyNotes:
        "The remembered target file is the primary edit candidate; related files should be inspected only if they appear in the prompt context.",
      plan: [
        {
          action: "read_only",
          path: target.path,
          description: `The AI model did not return a usable plan (timeout or invalid response), so no files were changed. Please try again — if this keeps happening, check your API provider status.`,
          patches: [],
        },
      ],
    };
  }

  if (target.content && target.content.length > 0) {
    const description = emptyResponse
      ? `The AI model returned no content — your API token quota may be exhausted or the provider may be rejecting requests. No files were changed. Check your provider account and try again.`
      : `The AI model did not return a usable plan (timeout or invalid response), so no files were changed. Please try the same request again.`;
    return {
      reasoning: emptyResponse
        ? "Model returned empty response, likely due to token quota exhaustion during the exploration phase."
        : "The planner timed out, so the safest fallback is to return the target file for a focused re-run.",
      dependencyNotes: "The target file is the most likely edit location, but the model did not produce a safe patch plan.",
      plan: [
        {
          action: "read_only",
          path: target.path,
          description,
          patches: [],
        },
      ],
    };
  }

  return {
    reasoning: "Could not generate a plan because the model timed out and the fallback could not confidently identify a safe patch.",
    dependencyNotes: "Need a smaller prompt or a more specific file anchor.",
    plan: [
      {
        action: "read_only",
        path: "",
        description: "The AI model did not produce a plan for this request — no files were changed. Please try again, or rephrase with the specific file or component you want edited.",
        patches: [],
      },
    ],
  };
}

export async function planChangesNode(state) {
  const { userMessage, fileContext, modelRoute, emit, rememberedTargetFile = "", investigation = null, retryCount = 0, verifyResult = null, workspacePath = "" } = state;

  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();
  // Exploration result overrides session memory: if the agent found a different target file,
  // do not lock to the remembered file from a previous turn.
  const explorationFoundDifferentTarget =
    Array.isArray(investigation?.priorityFiles) &&
    investigation.priorityFiles.length > 0 &&
    !investigation.priorityFiles.some(
      (f) => f === rememberedTargetFile || f.endsWith(rememberedTargetFile) || rememberedTargetFile.endsWith(f)
    );
  const lockToRemembered =
    Boolean(rememberedTargetFile) && !mentionsExplicitFile(cleanMsg) && !explorationFoundDifferentTarget;
  const isRetry = retryCount > 0;

  // On retry, extract error details from verifyResult or retryFileContext summaries
  const retryErrors = [];
  if (isRetry) {
    if (verifyResult?.issues?.length) {
      retryErrors.push(...verifyResult.issues);
    }
    for (const f of (fileContext || [])) {
      if (f?.summary?.startsWith("RETRY:")) {
        retryErrors.push(f.summary.replace(/^RETRY:\s*/, ""));
      }
    }
  }

  let mode = "surgical";
  if (isLintFixRequest(cleanMsg)) mode = "lint";
  else if (isBugFixRequest(cleanMsg)) mode = "debug";
  else if (isMultiTaskRequest(cleanMsg)) mode = "multi";
  else if (isScopedChange(cleanMsg) && !isCreativeRequest(cleanMsg)) mode = "scoped";
  else if (isCreativeRequest(cleanMsg) && !isReferenceCopyRequest(cleanMsg)) mode = "creative";

  // Full-rewrite requests ("completely redesign", "rewrite the entire file from
  // scratch") override multi/scoped: a file about to be REPLACED must never be
  // attacked with 8 surgical patches — anchors shift, JSX shatters, task dies.
  // These route to creative mode and (below) to the direct raw-code path.
  const isFullRewrite =
    /\bcompletely\s+(redesign|rewrite|rebuild)\b|\b(redesign|rewrite|rebuild)\b[^.\n]{0,80}\bfrom\s+scratch\b|\b(rewrite|redesign)\s+the\s+entire\s+(file|page)\b/i.test(cleanMsg);
  if (isFullRewrite && mode !== "debug") {
    if (mode !== "creative") console.log(`[PlanChanges] Full-rewrite request — overriding mode "${mode}" → creative`);
    mode = "creative";
  }

  if (lockToRemembered) console.log(`[PlanChanges] Locked to: ${rememberedTargetFile}`);
  console.log(`[PlanChanges] Mode: ${mode}${isRetry ? ` (retry ${retryCount})` : ""}`);
  console.log(`[PlanChanges] fileContext has ${(fileContext || []).length} file(s): ${(fileContext || []).map(f => /^https?:\/\//.test(f?.path || "") ? f.path : (f?.path?.split('/').pop() || '?')).join(', ')}`);
  if (retryErrors.length) console.log(`[PlanChanges] Retry errors:`, retryErrors.slice(0, 3).join(" | "));

  const modeEmoji = { debug: "🐛", creative: "🎨", surgical: "🧠", lint: "🔧", scoped: "🎯", multi: "📋" };
  const modeMsg = { debug: "Debugging...", creative: "Designing...", surgical: "Planning...", lint: "Fixing lint...", scoped: "Targeting element...", multi: "Planning all tasks..." };

  emit?.({
    type: "progress",
    stage: "planning",
    message: isRetry
      ? `🔄 Retry ${retryCount} — fixing previous error...`
      : `${modeEmoji[mode]} ${modeMsg[mode]}`,
  });

  // Creative work gets the project's real design tokens + matching expert skill
  // packs in the prompt, and (if configured) the strongest model the user has —
  // everything else is unchanged.
  const designTokens = mode === "creative" ? await extractDesignTokens(workspacePath, fileContext) : "";
  const designSkills = mode === "creative" ? await loadDesignSkills(cleanMsg, workspacePath) : "";
  const designGuidance = designTokens + designSkills;
  const planModelRoute = resolveCreativeModelRoute(modelRoute, mode);

  const system = buildSystemPrompt({
    rememberedTargetFile,
    lockToRemembered: lockToRemembered && mode !== "debug",
    mode,
    investigation,
    retryErrors,
    retryCount,
    designTokens: designGuidance,
  });

  let parsed = null;
  let rawResponse = "";
  let plannerError = null;

  // Budget sized to the ACTIVE model's real context window, not one flat constant
  // for every model (see resolveContextBudget). On retry, raise the per-file share
  // further so the LLM sees the full file when escalating to rewrite_file — a
  // truncated retry produces a partial rewrite missing the tail of the file.
  const { maxFileChars: baseMaxFileChars, totalContextChars } = resolveContextBudget(planModelRoute);
  const effectiveMaxFileChars = isRetry ? Math.floor(baseMaxFileChars * 1.5) : baseMaxFileChars;

  // Multi mode (first attempt only): plan each file separately so each LLM call
  // sees one file's FULL content instead of two truncated halves. This is the
  // Claude Code approach — avoids JSON truncation and stale-anchor failures.
  const filesToShowForSeq = pickFilesForPrompt(fileContext || [], String(userMessage).split(/conversation memory:/i)[0].trim(), rememberedTargetFile, investigation, mode);

  // Full-rewrite PRIMARY path (not a fallback): the model writes the complete new
  // file as raw code — no JSON, no patches, no anchors. This is how Claude Code
  // does whole-file work, and it is the only strategy that reliably survives a
  // ground-up redesign of a 300-line component.
  if (isFullRewrite && !isRetry && filesToShowForSeq[0]?.content) {
    emit?.({ type: "progress", stage: "planning", message: "Full rewrite requested — generating the complete file directly..." });
    parsed = await generateFullFileRewritePlan({
      cleanMsg,
      file: filesToShowForSeq[0],
      modelRoute: planModelRoute,
      emit,
      extraGuidance: designGuidance,
    });
    if (parsed) {
      console.log("[PlanChanges] Full-rewrite primary path produced the plan directly.");
      rawResponse = "[full-file rewrite — primary path]";
    }
  }

  if (!parsed && mode === "multi" && !isRetry && filesToShowForSeq.length > 1) {
    try {
      parsed = await planFilesSequentially({
        filesToShow: filesToShowForSeq,
        userMessage,
        system,
        modelRoute: planModelRoute,
        investigation,
      });
      if (parsed) rawResponse = JSON.stringify(parsed);
    } catch (seqErr) {
      console.warn("[PlanChanges] Sequential planning failed, falling back to combined:", seqErr.message);
      parsed = null;
    }
  }

  if (!parsed) {
  // For reference-copy tasks: the target file must come FIRST so it gets the full
  // token budget. The reference file (mentioned "as the design reference") comes second
  // and is truncated to the remaining budget — but shortenContentSmart will focus it
  // on the relevant section (e.g. the Revert button) using message keywords.
  // Without this, rememberedTargetFile boosts the reference file to first position and
  // the target file (settings/page.tsx) gets only ~5k chars, hiding the Save Changes button.
  let promptFileContext = fileContext || [];
  if (isReferenceCopyRequest(cleanMsg) && !isRetry && promptFileContext.length >= 2) {
    const msgLower = cleanMsg.toLowerCase();
    let latestPos = -1, targetIdx = 0;
    promptFileContext.forEach((f, i) => {
      const base = f.path.split("/").pop().replace(/\.[a-z]+$/, "").toLowerCase();
      const pos = msgLower.lastIndexOf(base);
      if (pos > latestPos) { latestPos = pos; targetIdx = i; }
    });
    if (targetIdx !== 0) {
      const ordered = [...promptFileContext];
      const [target] = ordered.splice(targetIdx, 1);
      ordered.unshift(target);
      promptFileContext = ordered;
      console.log(`[PlanChanges] Reference-copy: target first=${promptFileContext[0].path.split('/').pop()}, ref=${promptFileContext[1]?.path.split('/').pop()}`);
    }
  }

  const content = buildUserPrompt(
    userMessage,
    promptFileContext,
    rememberedTargetFile,
    lockToRemembered,
    mode,
    investigation,
    retryErrors,
    effectiveMaxFileChars,
    totalContextChars
  );

  try {
    const result = await generatePlanWithRetry({
      system,
      content,
      modelRoute: planModelRoute,
      mode,
      emit,
    });

    rawResponse = result.rawResponse || "";
    parsed = result.parsed;
    plannerError = result.error;
  } catch (err) {
    plannerError = err;
  }
  } // end if (!parsed) fallback block

  if (!parsed?.plan) {
    const preview = rawResponse.trim().slice(0, 600);
    console.warn("[PlanChanges] JSON parse failed. Raw response chars:", rawResponse.length, preview ? `— preview: ${preview}` : "— EMPTY (model returned no content)");

    // Before surrendering, try the raw-code path: plain fenced code instead of a
    // JSON plan. This rescues the most common failure — large code payloads whose
    // JSON-escaped form truncates mid-output — and costs LLM calls only in cases
    // that were about to fail anyway. Skip in lint/scoped modes (rewrite_file is
    // blocked there by design) and on verify retries (those already escalate).
    if (!isRetry && mode !== "lint" && mode !== "scoped") {
      const fallbackSteps = [];

      // CREATE targets first: explicit non-existent paths in the message are new
      // files — the edit-oriented fallback can't produce them (observed: it grabbed
      // the landing page and emitted the new component's code against it, which the
      // sanity check rightly rejected — task dead).
      const createTargets = await detectCreateTargets(cleanMsg, workspacePath, fileContext);
      for (const newPath of createTargets) {
        const createStep = await generateNewFilePlan({ cleanMsg, newPath, modelRoute: planModelRoute, emit, extraGuidance: designGuidance });
        if (createStep) fallbackSteps.push(createStep);
      }

      // Companion edit: if an in-context file is also named in the message (the
      // usual "create the component, then wire it into the page" shape), run the
      // edit fallback scoped to just that part of the request.
      const fullFileTarget =
        filesToShowForSeq[0] ||
        (fileContext || []).find((f) => f?.content);
      if (fullFileTarget?.content) {
        const editMsg = fallbackSteps.length > 0
          ? `The new file(s) ${fallbackSteps.map((s) => s.path).join(", ")} have ALREADY been created. Apply ONLY the part of the following request that edits ${fullFileTarget.path}:\n\n${cleanMsg}`
          : cleanMsg;
        const editParsed = await generateFullFileRewritePlan({ cleanMsg: editMsg, file: fullFileTarget, modelRoute: planModelRoute, emit, extraGuidance: designGuidance });
        if (editParsed?.plan?.length) fallbackSteps.push(...editParsed.plan);
      }

      if (fallbackSteps.length > 0) {
        parsed = {
          reasoning: "Structured JSON plan was unusable; regenerated the work as raw code.",
          dependencyNotes: "",
          plan: fallbackSteps,
        };
        console.log(`[PlanChanges] Recovered via raw-code fallback: ${fallbackSteps.map((s) => `${s.action} ${s.path}`).join(", ")}`);
        rawResponse = "[recovered via raw-code fallback]";
      }
    }
  }

  if (!parsed?.plan) {
    // Empty response = quota exhausted. Return a clean user-facing error immediately —
    // do NOT fall through to self-heal, which would inject page.tsx and produce
    // anchor mismatches on files the user never asked to change.
    if (rawResponse.trim().length === 0) {
      const errMsg = "⚠️ The AI model returned an empty response — your API token quota may be exhausted. Please check your quota at your API provider and try again.";
      console.warn("[PlanChanges] Empty response — aborting plan (no self-heal).");
      return {
        plan: [],
        finalAnswer: errMsg,
        messages: [new AIMessage(errMsg)],
      };
    }

    const fallback = buildFallbackPlan({
      fileContext,
      rememberedTargetFile,
      mode,
      emptyResponse: rawResponse.trim().length === 0,
    });

    if (fallback?.plan?.length) {
      console.warn("[PlanChanges] Falling back to deterministic plan.");
      parsed = fallback;
    } else {
      console.warn("[PlanChanges] Could not parse plan — using read_only fallback");
      parsed = {
        reasoning: "Could not generate a valid plan.",
        dependencyNotes: plannerError ? String(plannerError.message || plannerError) : "Planner returned no valid JSON.",
        plan: [
          {
            action: "read_only",
            path: "",
            description: rawResponse || "No plan generated.",
            patches: [],
            edits: [],
          },
        ],
      };
    }
  }

  // When the LLM explicitly returns plan:[] (valid JSON, empty array), it means it
  // couldn't determine what to change. Try the raw-code full-file path first — the
  // model may fail at structuring a JSON plan yet write the updated file perfectly —
  // then fall back to the deterministic plan so the user gets a useful message.
  if (Array.isArray(parsed.plan) && parsed.plan.length === 0) {
    console.warn("[PlanChanges] LLM returned empty plan[] — attempting full-file fallback");
    const emptyPlanTarget = filesToShowForSeq[0] || (fileContext || []).find((f) => f?.content);
    if (emptyPlanTarget?.content && !isRetry && mode !== "lint" && mode !== "scoped") {
      const recovered = await generateFullFileRewritePlan({ cleanMsg, file: emptyPlanTarget, modelRoute: planModelRoute, emit, extraGuidance: designGuidance });
      if (recovered?.plan?.length) {
        console.log("[PlanChanges] Recovered from empty plan[] via full-file rewrite fallback.");
        parsed = recovered;
      }
    }
    if (Array.isArray(parsed.plan) && parsed.plan.length === 0) {
      const fallback = buildFallbackPlan({ fileContext, rememberedTargetFile, mode });
      if (fallback?.plan?.length) parsed = fallback;
    }
  }

  let plan = (parsed.plan || []).map((item) => ({
    action: String(item.action || "read_only"),
    path: String(item.path || ""),
    description: String(item.description || ""),
    patches: normalizePatchList(item),
    edits: Array.isArray(item.edits)
      ? item.edits
          .filter((e) => e && typeof e.search === "string" && typeof e.replace === "string")
          .map((e) => ({ search: stripLineNumbers(e.search), replace: stripLineNumbers(e.replace) }))
      : [],
    content: typeof item.content === "string" ? stripLineNumbers(item.content) : "",
  }));

  plan = applyPathCanonicalization(plan, fileContext || [], rememberedTargetFile);
  plan = mergeSameFileEditSteps(plan);

  // Read-before-write invariant (Claude Code core rule): the planner may only EDIT
  // files whose content it was actually shown. A hallucinated or shortened path
  // (e.g. "app/page.tsx" when the loaded file is "app/landing/page.tsx") once sent
  // a full landing-page redesign into the CHAT APP's page. Edits to unread files are
  // blocked unless the user's message literally contains that exact path. "create"
  // is exempt — new files have nothing to read.
  {
    const readPaths = new Set((fileContext || []).map((f) => f?.path).filter(Boolean));
    plan = plan.map((step) => {
      const isWrite = step.action === "edit" || step.action === "rewrite_file" || step.action === "delete";
      if (!isWrite || !step.path || readPaths.has(step.path) || cleanMsg.includes(step.path)) return step;
      console.warn(`[PlanChanges] 🚫 Blocked ${step.action} to unread file "${step.path}" — not in context (loaded: ${[...readPaths].map(p => p.split("/").pop()).join(", ")})`);
      return {
        ...step,
        action: "read_only",
        patches: [],
        edits: [],
        content: "",
        description: `Blocked: the plan targeted "${step.path}", a file that was never loaded into context. Edits are only allowed on files the planner has read.`,
      };
    });
  }

  if (mode === "lint" || mode === "scoped") {
    plan = plan.map((item) => {
      const droppedCount = item.patches.filter((p) => p.kind === "rewrite_file").length;
      const safePatches = item.patches.filter((p) => p.kind !== "rewrite_file");

      if (droppedCount === 0) return item;

      console.warn(`[PlanChanges] Blocked ${droppedCount} rewrite_file patch(es) for "${item.path}" in ${mode} mode`);

      if (safePatches.length > 0) {
        return { ...item, patches: safePatches };
      }

      return {
        ...item,
        action: "read_only",
        patches: [],
        edits: [],
        content: "",
        description: `Skipped: the model tried to rewrite the whole file for a targeted element change, which is not allowed. Re-run with a more specific instruction naming the exact element.`,
      };
    });
  }

  if (lockToRemembered && mode !== "debug" && rememberedTargetFile) {
    const before = plan.length;
    plan = plan.filter(
      (p) =>
        p.action === "read_only" ||
        p.action === "create" ||   // never block new file creation
        p.path === rememberedTargetFile ||
        p.path.endsWith(rememberedTargetFile) ||
        rememberedTargetFile.endsWith(p.path)
    );

    if (plan.length < before) {
      console.log(`[PlanChanges] Dropped ${before - plan.length} edits to other files`);
    }

    if (plan.length === 0) {
      plan = [
        {
          action: "read_only",
          path: rememberedTargetFile,
          description: "No applicable change found.",
          patches: [],
          edits: [],
          content: "",
        },
      ];
    }
  }

  // read_more: model explicitly signals it needs a specific section of a truncated file.
  // Load that section and retry planning once (like Claude Code's Read-on-demand).
  if (parsed.read_more?.length > 0 && !isRetry) {
    const expandedContext = [...(fileContext || [])];
    let anyExpanded = false;
    for (const req of parsed.read_more) {
      const target = (fileContext || []).find(f => f.path === req.path || f.path.endsWith(req.path));
      if (!target) continue;
      const around = String(req.around || "");
      if (!around) continue;
      // Read the FULL file from disk — the explore may have stored only a partial
      // section (start_line..end_line), so target.content may be truncated.
      let rawContent = target.content;
      try {
        const absPath = path.resolve(workspacePath || PC_PROJECT_ROOT, target.path);
        rawContent = await fs.readFile(absPath, "utf-8");
      } catch { /* fall back to stored content */ }
      const lines = rawContent.split("\n");
      const keywords = around.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      const scores = lines.map(l => keywords.reduce((s, kw) => s + (l.toLowerCase().includes(kw) ? 1 : 0), 0));
      const maxScore = Math.max(...scores);
      if (maxScore === 0) continue;
      const bestLine = scores.indexOf(maxScore);
      const WINDOW = 120;
      const start = Math.max(0, bestLine - Math.floor(WINDOW / 2));
      const end = Math.min(lines.length, start + WINDOW);
      const snippet = [
        `// ── [read_more: lines ${start + 1}–${end} of ${target.path}] ──`,
        ...lines.slice(start, end),
      ].join("\n");
      // Append as a supplemental section to the target file's content
      expandedContext.forEach(f => {
        if (f.path === target.path) {
          f._readMoreSnippet = snippet;
        }
      });
      anyExpanded = true;
      emit?.({ type: "progress", stage: "planning", message: `📖 Loading more of ${target.path.split("/").pop()} (lines ${start + 1}–${end})…` });
      console.log(`[PlanChanges] read_more: loaded ${target.path} lines ${start + 1}–${end} (around "${around}")`);
    }
    if (anyExpanded) {
      // Rebuild the prompt with supplemental snippets appended, then retry once
      const supplemented = expandedContext.map(f =>
        f._readMoreSnippet
          ? { ...f, content: f.content + "\n\n" + f._readMoreSnippet }
          : f
      );
      const retryContent = buildUserPrompt(userMessage, supplemented, rememberedTargetFile, lockToRemembered, mode, investigation, [], effectiveMaxFileChars, totalContextChars);
      const retryResult = await generatePlanWithRetry({ system, content: retryContent, modelRoute: planModelRoute, mode, emit });
      if (retryResult.parsed?.plan) {
        const retryPlan = applyPathCanonicalization(
          retryResult.parsed.plan.map(item => ({
            action: String(item.action || "read_only"),
            path: String(item.path || ""),
            description: String(item.description || ""),
            patches: normalizePatchList(item),
            edits: [],
            content: typeof item.content === "string" ? stripLineNumbers(item.content) : "",
          })),
          fileContext || [],
          rememberedTargetFile
        );
        if (retryPlan.some(s => s.action !== "read_only")) {
          console.log(`[PlanChanges] read_more retry succeeded: ${retryPlan.length} step(s)`);
          return {
            plan: retryPlan,
            fileContext,
            messages: [new AIMessage(`read_more plan (${retryPlan.length}):\n` +
              retryPlan.map((p, i) => `  ${i + 1}. [${p.action.toUpperCase()}] ${p.path}`).join("\n"))],
          };
        }
      }
    }
  }

  // Self-heal: if ALL steps are read_only on the first attempt, the planner
  // couldn't see the file it needed. Load missing files from the descriptions
  // and retry planning once — no graph cycle needed.
  const allReadOnly = plan.length > 0 && plan.every(s => s.action === "read_only");
  if (allReadOnly && !isRetry) {
    const root = workspacePath || PC_PROJECT_ROOT;
    const healedFiles = await selfHealLoadMissingFiles(plan, fileContext || [], root, userMessage, emit);
    if (healedFiles.length > 0) {
      console.log(`[PlanChanges] Self-heal: retrying with ${healedFiles.length} new file(s)`);
      emit?.({ type: "progress", stage: "planning", message: "🔄 Found missing files — retrying plan..." });
      const expandedContext = [...(fileContext || []), ...healedFiles];

      // Augment userMessage with a reference snippet from any already-loaded file
      // that shows the pattern to apply (e.g. the AssistantMessage copy button).
      // This is needed because planFilesSequentially only shows the target file
      // content — the model has no other context to understand what to build.
      let userMessageForSeq = userMessage;
      for (const ref of (fileContext || [])) {
        if (!ref?.content) continue;
        const refLines = ref.content.split("\n");
        // Extract keywords from the user message to find the relevant section of the reference file.
        // Generic: works for any component ("Revert button", "copy button", "send button", etc.)
        const refKeywords = String(userMsg || "").split(/conversation memory:/i)[0]
          .toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
          .filter(w => w.length >= 4 && !["this","that","with","from","have","will","just","what","your","into","over","then","them","they","make","also","same","style","file","button","class","code","after"].includes(w));
        // Find the line in the reference file most relevant to the user's request
        const scoredLines = refLines.map((l, idx) => ({
          idx,
          score: refKeywords.reduce((s, kw) => s + (l.toLowerCase().includes(kw) ? 1 : 0), 0),
        }));
        const best = scoredLines.reduce((a, b) => b.score > a.score ? b : a, { idx: -1, score: 0 });
        const patternIdx = best.score > 0 ? best.idx : -1;
        if (patternIdx >= 0) {
          const start = Math.max(0, patternIdx - 5);
          const snippet = refLines.slice(start, Math.min(refLines.length, start + 40)).join("\n");
          userMessageForSeq = `${userMessage}\n\n// Pattern to follow from ${ref.path}:\n${snippet}`;
          console.log(`[PlanChanges] Self-heal: injecting reference pattern from ${ref.path} (score=${best.score}, line=${patternIdx + 1})`);
          break;
        }
      }

      // Use sequential planning (one LLM call per new file) so each file gets
      // its own full token budget. Combined prompts fail when reference file +
      // target file exceed MAX_TOTAL_CONTEXT_CHARS.
      const seqResult = await planFilesSequentially({
        filesToShow: healedFiles, // only newly loaded files are edit targets
        userMessage: userMessageForSeq,
        system,
        modelRoute,
        investigation,
      });

      if (seqResult?.plan) {
        const healedPlan = applyPathCanonicalization(
          seqResult.plan.map(item => ({
            action: String(item.action || "read_only"),
            path: String(item.path || ""),
            description: String(item.description || ""),
            patches: normalizePatchList(item),
            edits: [],
            content: typeof item.content === "string" ? stripLineNumbers(item.content) : "",
          })),
          expandedContext,
          rememberedTargetFile
        );
        if (healedPlan.some(s => s.action !== "read_only")) {
          plan = healedPlan;
          console.log(`[PlanChanges] Self-heal succeeded: ${plan.length} step(s)`);
          return {
            plan,
            fileContext: expandedContext,
            messages: [new AIMessage(`Self-heal plan (${plan.length}):\n` +
              plan.map((p, i) => `  ${i + 1}. [${p.action.toUpperCase()}] ${p.path} – ${p.description}`).join("\n"))],
          };
        }
      }
    }
  }

  emit?.({
    type: "plan",
    reasoning: parsed.reasoning,
    dependencyNotes: parsed.dependencyNotes || "",
    steps: plan.map((p) => ({
      action: p.action,
      path: p.path,
      description: p.description,
      patchCount: p.patches.length || p.edits.length,
    })),
    message: `📋 Plan: ${plan.length} step(s)`,
  });

  console.log(`[PlanChanges] ${plan.length} steps:`);
  for (const [i, p] of plan.entries()) {
    console.log(`  [${i + 1}] action=${p.action} path=${p.path || "(none)"} patches=${p.patches.length}`);
  }

  return {
    plan,
    messages: [
      new AIMessage(
        `Plan (${plan.length}):\n` +
          plan.map((p, i) => `  ${i + 1}. [${p.action.toUpperCase()}] ${p.path} – ${p.description}`).join("\n")
      ),
    ],
  };
}