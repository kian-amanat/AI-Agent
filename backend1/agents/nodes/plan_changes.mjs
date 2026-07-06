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

// ── Self-healing: load missing files when the plan is all read_only ────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", "uploads", ".agent-history"]);
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

  // Fallback: "user message" with no component found → load the main page
  if (newFiles.length === 0 && /user.?message|chat.?bubble|message.?bubble/i.test(descriptions + " " + (userMsg || ""))) {
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
  // Comma-separated actions — expanded verb list (includes create/build/implement/design/move/refactor)
  if (/\b(create|make|add|fix|change|update|remove|improve|build|implement|design|move|refactor|rewrite)\b.{3,80},\s+(?:and\s+)?\b(create|make|add|fix|change|update|remove|improve|build|implement|design|move|refactor|rewrite)\b/i.test(m)) return true;
  // "I want X things"
  if (/\bi\s+(?:want|need|would like)\s+(?:to\s+(?:have\s+)?)?\d+\b/i.test(m)) return true;
  // "Edit these 2 files", "update 3 files"
  if (/\b(edit|update|change|modify|fix)\s+(?:these\s+)?([2-9]|two|three|four|five)\s+files?\b/i.test(m)) return true;
  return false;
}

function isCreativeRequest(msg) {
  return /\b(creative|exciting|beautiful|stunning|amazing|cool|fancy|animate|animation|gradient|glow|shadow|color|colour|design|be creative|advanced|premium|modern|sleek|vibrant|dynamic|make it (pop|shine|stand out))\b/i.test(
    String(msg || "")
  );
}

function isBugFixRequest(msg) {
  return /\b(fix|bug|error|crash|broken|failed|exception|stack trace|TypeError|ReferenceError|SyntaxError|Bad Request|404|500|401|503|not working|doesn't work|doesn.t work)\b/i.test(
    String(msg || "")
  );
}

function isLintFixRequest(msg) {
  return /\b(lint|linting|eslint|tslint|typecheck|type.check|no-explicit-any|no-unused|prefer-const|lint error|lint warning|lint fix|fix lint|fix.*lint|fix.*typescript|fix.*eslint)\b/i.test(
    String(msg || "")
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
      const bestLine = scores.indexOf(maxScore);
      const windowLines = Math.floor(maxChars / charsPerLine);
      const halfWindow = Math.floor(windowLines / 2);

      const headLines = Math.min(25, bestLine);
      const windowStart = Math.max(headLines, bestLine - halfWindow);
      const windowEnd = Math.min(lines.length, windowStart + windowLines);

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

function buildSystemPrompt({ rememberedTargetFile, lockToRemembered, mode, investigation, retryErrors = [] }) {
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
## CREATIVE MODE
Use stronger visual design, better layout, thoughtful motion, and polished UI.
Be bold when it improves the result. Do not introduce random complexity.`,

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

  const hasMultipleRetries = retryErrors.length >= 2;
  const retrySection = retryErrors.length > 0
    ? `
⚠️ RETRY — PREVIOUS ATTEMPT FAILED
The last patch was rejected for the following reason(s):
${retryErrors.map(e => `  • ${e}`).join("\n")}

${hasMultipleRetries
  ? `ESCALATE TO REWRITE: Two surgical patches already failed. For this retry, use rewrite_file with the COMPLETE, CORRECTLY MODIFIED file content. Do NOT use replace_block or replace_text — they keep failing because the search anchor does not match. Write the ENTIRE file from scratch with the change applied.`
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

CSS LAYOUT RULES (Tailwind / absolute positioning)
- An \`absolute\` element sizes relative to its nearest \`relative\` ancestor — NOT to the page.
- When the task is "make a vertical line span all list items": the line must be \`absolute\` inside the CONTENT container (the div that grows with items), NOT inside a scroll wrapper (a div with \`overflow-y-auto\` or \`max-h-*\`). If the line currently sits inside the scroll wrapper: (1) remove \`relative\` from the scroll wrapper, (2) add \`relative\` to the inner items div, (3) move the line element inside that inner div, AND (4) set the line to \`top-0 bottom-0\` so it spans the full content height. All four changes must be in the same patch.
- A scroll container with \`max-h-[320px]\` is only 320 px tall in the viewport. An \`absolute top-0 bottom-0\` line inside it will never be taller than 320 px no matter how many items exist. After moving \`relative\` to the items container, also update any \`top-X bottom-X\` values on the line to \`top-0 bottom-0\` so it spans actual content height.
- For hover-only UI (copy buttons, action overlays): add \`group\` to the wrapper, then \`opacity-0 group-hover:opacity-100\` to the action element — no JS state needed.

If you cannot confidently fix the issue, return a read_only step explaining the exact blocker.`;
}

function buildUserPrompt(userMessage, fileContext, rememberedTargetFile, lockToRemembered, mode, investigation, retryErrors = []) {
  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();

  const filesToShow = pickFilesForPrompt(fileContext, cleanMsg, rememberedTargetFile, investigation, mode);

  const fileSnippets = [];
  let totalChars = 0;

  // Multi mode: keep each file small so the combined input doesn't eat the model's
  // output budget. gapgpt-qwen-3.6 has ~8192 total tokens; with 2 files at 10k chars
  // each the input alone uses ~6k tokens and the JSON plan gets truncated mid-write.
  // 5000 chars per file leaves ~4000 tokens for the plan output (enough for 2 patches).
  const totalBudget = MAX_TOTAL_CONTEXT_CHARS;
  const perFileBudget = mode === "multi" ? 5000 : MAX_FILE_CHARS;

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
  // LLMs sometimes embed literal newlines/tabs inside JSON string values instead of \n/\t.
  // Walk char-by-char and escape bare control characters that appear inside strings.
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
      result += ch;
      inString = !inString;
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
    return {
      ...item,
      path: canonicalizePlanPath(item.path, fileContext, rememberedTargetFile),
    };
  });
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

async function generatePlanWithRetry({ system, content, modelRoute, mode = "surgical" }) {
  let lastError = null;
  let rawResponse = "";

  // Keep maxOut consistent across attempts so the retry isn't token-starved.
  // single_file prompts are smaller (one full file) so 4096 is plenty;
  // other modes need more room for the full JSON plan.
  const maxOut = (mode === "single_file") ? 4096 : 6000;

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

  return { rawResponse, parsed: null, error: lastError };
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

  if (mode === "debug") {
    return {
      reasoning: "The planner timed out, so the safest fallback is to inspect the target file and the files directly related to the request.",
      dependencyNotes:
        "The remembered target file is the primary edit candidate; related files should be inspected only if they appear in the prompt context.",
      plan: [
        {
          action: "read_only",
          path: target.path,
          description: `Planner fallback: inspect ${target.path} because the model call timed out before producing JSON.`,
          patches: [],
        },
      ],
    };
  }

  if (target.content && target.content.length > 0) {
    const description = emptyResponse
      ? `Token quota may be exhausted — the model returned no content. Retry with a more specific request targeting "${target.path}".`
      : `Inspect ${target.path} and retry planning with a smaller prompt.`;
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
        description: "Planner fallback failed.",
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
  else if (isCreativeRequest(cleanMsg)) mode = "creative";

  if (lockToRemembered) console.log(`[PlanChanges] Locked to: ${rememberedTargetFile}`);
  console.log(`[PlanChanges] Mode: ${mode}${isRetry ? ` (retry ${retryCount})` : ""}`);
  console.log(`[PlanChanges] fileContext has ${(fileContext || []).length} file(s): ${(fileContext || []).map(f => f?.path?.split('/').pop() ?? '?').join(', ')}`);
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

  const system = buildSystemPrompt({
    rememberedTargetFile,
    lockToRemembered: lockToRemembered && mode !== "debug",
    mode,
    investigation,
    retryErrors,
  });

  let parsed = null;
  let rawResponse = "";
  let plannerError = null;

  // Multi mode (first attempt only): plan each file separately so each LLM call
  // sees one file's FULL content instead of two truncated halves. This is the
  // Claude Code approach — avoids JSON truncation and stale-anchor failures.
  const filesToShowForSeq = pickFilesForPrompt(fileContext || [], String(userMessage).split(/conversation memory:/i)[0].trim(), rememberedTargetFile, investigation, mode);

  if (mode === "multi" && !isRetry && filesToShowForSeq.length > 1) {
    try {
      parsed = await planFilesSequentially({
        filesToShow: filesToShowForSeq,
        userMessage,
        system,
        modelRoute,
        investigation,
      });
      if (parsed) rawResponse = JSON.stringify(parsed);
    } catch (seqErr) {
      console.warn("[PlanChanges] Sequential planning failed, falling back to combined:", seqErr.message);
      parsed = null;
    }
  }

  if (!parsed) {
  const content = buildUserPrompt(
    userMessage,
    fileContext || [],
    rememberedTargetFile,
    lockToRemembered,
    mode,
    investigation,
    retryErrors
  );

  try {
    const result = await generatePlanWithRetry({
      system,
      content,
      modelRoute,
      mode,
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
      const retryContent = buildUserPrompt(userMessage, supplemented, rememberedTargetFile, lockToRemembered, mode, investigation, []);
      const retryResult = await generatePlanWithRetry({ system, content: retryContent, modelRoute, mode });
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
        const patternIdx = refLines.findIndex(l =>
          /copyToClipboard|group-hover:opacity|Copy.*className|clipboard/i.test(l)
        );
        if (patternIdx >= 0) {
          const start = Math.max(0, patternIdx - 5);
          const snippet = refLines.slice(start, Math.min(refLines.length, start + 30)).join("\n");
          userMessageForSeq = `${userMessage}\n\n// Pattern to follow from ${ref.path}:\n${snippet}`;
          console.log(`[PlanChanges] Self-heal: injecting reference pattern from ${ref.path}`);
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