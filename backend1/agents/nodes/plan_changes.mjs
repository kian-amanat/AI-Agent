import { AIMessage } from "@langchain/core/messages";
import { callLLM } from "../../services/llm.mjs";

/**
 * plan_changes.mjs — DIFF-BASED with memory awareness
 * The LLM outputs minimal SEARCH/REPLACE blocks.
 * If a remembered target file exists and the user didn't name a new
 * file, the LLM is told to edit ONLY the remembered file.
 */

// Does the message explicitly name a file or component?
function mentionsExplicitFile(message) {
  const m = String(message || "");
  if (/\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|html)\b/i.test(m)) return true;
  // component-name words that imply a specific file
  if (/\b(sidebar|navbar|header|footer|composer|chatsidebar|chatheader|login|signup|connection|dashboard|settings)\b/i.test(m)) return true;
  return false;
}

function buildSystemPrompt(rememberedTargetFile, lockToRemembered) {
  let focusRule = "";
  if (lockToRemembered && rememberedTargetFile) {
    focusRule = `
🎯 CRITICAL FOCUS RULE:
The user is continuing to work on this file: "${rememberedTargetFile}"
The user did NOT name a different file, so this is a follow-up to the previous edit.
You MUST make your edits ONLY in "${rememberedTargetFile}".
Do NOT edit any other file, even if the same text/keyword appears elsewhere.
If the requested change cannot be applied to "${rememberedTargetFile}", return a "read_only" plan explaining why.`;
  }

  return `You are Kodo, an expert AI software engineer embedded in VS Code.
You make PRECISE, surgical edits to the user's project files.
${focusRule}

You MUST respond with ONLY a JSON object (no markdown fences, no prose):
{
  "reasoning": "One short sentence describing the change.",
  "plan": [
    {
      "action": "edit",
      "path": "relative/path/to/file.tsx",
      "description": "what changed",
      "edits": [
        { "search": "EXACT text to find (verbatim, with whitespace)", "replace": "new text" }
      ]
    }
  ]
}

ACTION TYPES:
- "edit"      → provide "edits": array of {search, replace}. NO "content".
- "create"    → provide "content": full new file. NO "edits".
- "delete"    → no content/edits.
- "read_only" → no changes; explanation in "description".

RULES FOR "search":
- Copy EXACT text from the file, character-for-character, including indentation.
- Include 3-6 lines of surrounding context so the match is UNIQUE.
- Each {search} must appear exactly once. Make multiple small edits.
- NEVER paste the whole file. Change ONLY what the user asked for.
- Preserve existing code style.

Output ONLY the JSON.`;
}

function buildUserPrompt(userMessage, fileContext, rememberedTargetFile, lockToRemembered) {
  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();

  // If locked to remembered file, only show THAT file's content to the LLM
  let filesToShow = fileContext.filter(f => f.content);
  if (lockToRemembered && rememberedTargetFile) {
    const onlyRemembered = filesToShow.filter(f =>
      f.path === rememberedTargetFile ||
      f.path.endsWith(rememberedTargetFile) ||
      rememberedTargetFile.endsWith(f.path)
    );
    if (onlyRemembered.length > 0) filesToShow = onlyRemembered;
  }

  const fileSnippets = filesToShow
    .map(f => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const focusNote = (lockToRemembered && rememberedTargetFile)
    ? `\n\nIMPORTANT: Edit ONLY "${rememberedTargetFile}". This is a follow-up to a previous edit on that file.`
    : "";

  return `User request: "${cleanMsg}"${focusNote}

Produce minimal SEARCH/REPLACE edits that satisfy EXACTLY this request and nothing else.

${fileSnippets ? `Current project files:\n\n${fileSnippets}` : "No matching files found."}

Output ONLY JSON with small, unique search/replace blocks.`;
}

function extractJSON(text) {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = stripped.indexOf("{");
  const end   = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); }
  catch { return null; }
}

export async function planChangesNode(state) {
  const { userMessage, fileContext, modelRoute, emit, rememberedTargetFile = "" } = state;

  // Decide whether to LOCK editing to the remembered file:
  // only when we HAVE a remembered file AND the user did NOT name a new file.
  const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();
  const lockToRemembered = Boolean(rememberedTargetFile) && !mentionsExplicitFile(cleanMsg);

  if (lockToRemembered) {
    console.log(`[PlanChanges] 🔒 Locked to remembered file: ${rememberedTargetFile}`);
  }

  emit?.({ type: "progress", stage: "planning", message: lockToRemembered
    ? `🧠 Planning edits to ${rememberedTargetFile.split("/").pop()}...`
    : "🧠 Planning precise edits..." });

  const system  = buildSystemPrompt(rememberedTargetFile, lockToRemembered);
  const content = buildUserPrompt(userMessage, fileContext || [], rememberedTargetFile, lockToRemembered);

  let parsed = null, rawResponse = "";
  try {
    const result = await callLLM({
      system,
      messages: [{ role: "user", content }],
      modelRoute,
      maxTokens: 4000,
      temperature: 0,
    });
    rawResponse = result?.content || "";
    parsed = extractJSON(rawResponse);
  } catch (err) {
    console.error("[PlanChanges] LLM error:", err.message);
  }

  if (!parsed?.plan) {
    console.warn("[PlanChanges] Could not parse plan — read_only fallback");
    parsed = {
      reasoning: "Could not generate a plan.",
      plan: [{ action: "read_only", path: "", description: rawResponse || "No plan generated.", edits: [], content: "" }],
    };
  }

  let plan = (parsed.plan || []).map(item => ({
    action:      String(item.action || "read_only"),
    path:        String(item.path   || ""),
    description: String(item.description || ""),
    edits:       Array.isArray(item.edits) ? item.edits
                   .filter(e => e && typeof e.search === "string" && typeof e.replace === "string")
                   .map(e => ({ search: e.search, replace: e.replace })) : [],
    content:     typeof item.content === "string" ? item.content : "",
  }));

  // ★ Safety net: if locked, drop any edits to files OTHER than the remembered one
  if (lockToRemembered && rememberedTargetFile) {
    const before = plan.length;
    plan = plan.filter(p =>
      p.action === "read_only" ||
      p.path === rememberedTargetFile ||
      p.path.endsWith(rememberedTargetFile) ||
      rememberedTargetFile.endsWith(p.path)
    );
    if (plan.length < before) {
      console.log(`[PlanChanges] 🔒 Dropped ${before - plan.length} edit(s) to non-remembered files`);
    }
    if (plan.length === 0) {
      plan = [{ action: "read_only", path: rememberedTargetFile, description: `No applicable change found in ${rememberedTargetFile}.`, edits: [], content: "" }];
    }
  }

  emit?.({
    type:      "plan",
    reasoning: parsed.reasoning,
    steps:     plan.map(p => ({ action: p.action, path: p.path, description: p.description, editCount: p.edits.length })),
    message:   `📋 Plan ready: ${plan.length} step(s)`,
  });

  console.log(`[PlanChanges] ${plan.length} steps, ${plan.reduce((n, p) => n + p.edits.length, 0)} edits planned`);

  return {
    plan,
    messages: [
      new AIMessage(
        `Plan (${plan.length} step${plan.length !== 1 ? "s" : ""}):\n` +
        plan.map((p, i) => `  ${i + 1}. [${p.action.toUpperCase()}] ${p.path}${p.edits.length ? ` (${p.edits.length} edits)` : ""} – ${p.description}`).join("\n")
      ),
    ],
  };
}
