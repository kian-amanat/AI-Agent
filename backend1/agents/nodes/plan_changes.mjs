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

import { AIMessage } from "@langchain/core/messages";
import { callLLM } from "../../services/llm.mjs";

const MAX_PROMPT_FILES = 5;
const MAX_FILE_CHARS = 14000;
const MAX_TOTAL_CONTEXT_CHARS = 50000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // "change button X in sidebar", "update the collapse icon", "make the search button red"
  // Detects references to a specific named element inside a larger container
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

  const headLen = Math.floor(maxChars * 0.72);
  const tailLen = Math.floor(maxChars * 0.28);
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);

  return `${head}\n... [truncated ${text.length - headLen - tailLen} chars]\n${tail}`;
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
- Do NOT restructure, reformat, or reorder surrounding code.
- One-file changes are strongly preferred. Never edit a second file unless the bug spans two layers.`,

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

  const retrySection = retryErrors.length > 0
    ? `
⚠️ RETRY — PREVIOUS ATTEMPT FAILED
The last patch was rejected for the following reason(s):
${retryErrors.map(e => `  • ${e}`).join("\n")}

Do NOT repeat the same patch. Generate a DIFFERENT, CORRECT patch that avoids these errors.
For JSX/TSX files: mentally trace the tag structure of your patch before outputting it.
`
    : "";

  return `You are Kodo, a surgical AI code editor.
${focusRule}${retrySection}${investigationSection}${modeSection[mode] || modeSection.surgical}

JSX/TSX VALIDITY RULES (always enforced)
- Every JSX attribute MUST be inside its element's opening tag. Never leave props floating outside a tag.
- All tags must be balanced: every <Foo> must have </Foo> or be self-closed <Foo />.
- A JSX expression returns exactly one root element. Use a fragment (<> </>) if you need siblings.
- After applying your patch, mentally re-read the resulting JSX to confirm it is valid.
- If your patch adds new JSX elements, confirm existing closing tags are still present.

DEPENDENCY RULES
- ALWAYS use the EXACT file path shown in "### File: <path>" headers below. Never abbreviate.
- If an error trace says "app/lib/api.ts" but the file is shown as "chatbot/my-chatbot-ui/app/lib/api.ts", use the full path.
- Before emitting a plan step, verify the path appears in the file list below.
- If you need to edit a file NOT in the list, emit a read_only step explaining what you need.

OUTPUT FORMAT
Return ONLY valid JSON:
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

If you cannot confidently fix the issue, return a read_only step explaining the exact blocker.`;
}

function buildUserPrompt(userMessage, fileContext, rememberedTargetFile, lockToRemembered, mode, investigation, retryErrors = []) {
  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();

  const filesToShow = pickFilesForPrompt(fileContext, cleanMsg, rememberedTargetFile, investigation, mode);

  const fileSnippets = [];
  let totalChars = 0;

  for (const f of filesToShow) {
    const outline = buildJsxOutline(f.content, f.path);
    const numbered = addLineNumbers(shortenContent(f.content));
    const summary = f.summary ? `\nSummary: ${f.summary}` : "";
    const block = `### File: ${f.path}${summary}${outline}\n\`\`\`\n${numbered}\n\`\`\``;

    if (totalChars + block.length > MAX_TOTAL_CONTEXT_CHARS && fileSnippets.length > 0) break;
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
    scoped: "The user referenced a specific element. Use replace_block or replace_text targeting ONLY that element. NEVER use rewrite_file. Leave all surrounding code untouched.",
    surgical: "Make the MINIMUM change. Touch ONLY the code the user explicitly mentioned. Every line not mentioned in the request must remain identical.",
  };

  const retryNote = retryErrors.length > 0
    ? `\n\n⚠️ RETRY: Previous patch failed — ${retryErrors.slice(0, 2).join(" | ")}. Generate a DIFFERENT correct patch.`
    : "";

  return `User request: "${cleanMsg}"${focusNote}${investigationNote}${retryNote}

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



async function generatePlanWithRetry({ system, content, modelRoute }) {
  let lastError = null;
  let rawResponse = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callLLM({
        system,
        messages: [{ role: "user", content }],
        modelRoute,
        maxTokens: attempt === 0 ? 8000 : 4000,
        temperature: 0,
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

function buildFallbackPlan({ fileContext, rememberedTargetFile, mode }) {
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
    return {
      reasoning: "The planner timed out, so the safest fallback is to return the target file for a focused re-run.",
      dependencyNotes: "The target file is the most likely edit location, but the model did not produce a safe patch plan.",
      plan: [
        {
          action: "read_only",
          path: target.path,
          description: `Inspect ${target.path} and retry planning with a smaller prompt.`,
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
  const { userMessage, fileContext, modelRoute, emit, rememberedTargetFile = "", investigation = null, retryCount = 0, verifyResult = null } = state;

  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();
  const lockToRemembered = Boolean(rememberedTargetFile) && !mentionsExplicitFile(cleanMsg);
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
  else if (isScopedChange(cleanMsg) && !isCreativeRequest(cleanMsg)) mode = "scoped";
  else if (isCreativeRequest(cleanMsg)) mode = "creative";

  if (lockToRemembered) console.log(`[PlanChanges] Locked to: ${rememberedTargetFile}`);
  console.log(`[PlanChanges] Mode: ${mode}${isRetry ? ` (retry ${retryCount})` : ""}`);
  if (retryErrors.length) console.log(`[PlanChanges] Retry errors:`, retryErrors.slice(0, 3).join(" | "));

  const modeEmoji = { debug: "🐛", creative: "🎨", surgical: "🧠", lint: "🔧", scoped: "🎯" };
  const modeMsg = { debug: "Debugging...", creative: "Designing...", surgical: "Planning...", lint: "Fixing lint...", scoped: "Targeting element..." };

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

  const content = buildUserPrompt(
    userMessage,
    fileContext || [],
    rememberedTargetFile,
    lockToRemembered,
    mode,
    investigation,
    retryErrors
  );

  let parsed = null;
  let rawResponse = "";
  let plannerError = null;

  try {
    const result = await generatePlanWithRetry({
      system,
      content,
      modelRoute,
    });

    rawResponse = result.rawResponse || "";
    parsed = result.parsed;
    plannerError = result.error;
  } catch (err) {
    plannerError = err;
  }

  if (!parsed?.plan) {
    const preview = rawResponse.trim().slice(0, 600);
    console.warn("[PlanChanges] JSON parse failed. Raw response chars:", rawResponse.length, preview ? `— preview: ${preview}` : "— EMPTY (model returned no content)");
    const fallback = buildFallbackPlan({
      fileContext,
      rememberedTargetFile,
      mode,
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