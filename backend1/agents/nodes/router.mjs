/**
 * router.mjs — minimal intent gate (Claude Code approach).
 *
 * Claude Code doesn't pre-classify messages with regex; the agent judges.
 * The only routing decision Kodo still makes is "answer" (pure conversation —
 * no workspace tools needed, cheaper + streams instantly) vs "agent" (the
 * unified tool loop). Clear-cut cases short-circuit locally; everything
 * ambiguous goes to one tiny LLM classification call.
 */

const GREETING_RE = /^(hi|hello|hey|سلام|مرحبا|hola|bonjour|ciao|yo|sup|howdy|greetings|salut|hiya|heya|thanks|thank you|thx|ty|ممنون|مرسی|cheers|ok|okay|got it|bye|goodbye|good (morning|evening|afternoon|night)|how are you|what's up|whats up|who are you|what are you)[!?.,\s]*$/i;

// The user explicitly asked for words, not changes — always "answer".
const NO_ACTION_RE = /\b(just\s+(tell|explain|describe|show)\s+me|without\s+(any\s+)?(action|edit|editing|change|changing|modif\w+)|don'?t\s+(edit|change|modify|touch|write|create)|no\s+(changes?|action|edits?|code\s+changes?))\b/i;

// Unmistakable change requests — no LLM call needed.
const AGENT_NOUNS = "page|file|component|section|button|navbar|footer|header|hero|landing|route|api|function|bug|error|test|package|animation|style|css|layout|form|feedback|option|feature|modal|dialog|toast|input|field|menu|sidebar|card|table|list|route|endpoint|feature";
const OBVIOUS_AGENT_RE = new RegExp(`\\b(fix|add|create|make|build|implement|refactor|rewrite|update|change|remove|delete|rename|move|improve|redesign|restyle|animate|install|apply|run\\s+tests?|typecheck|debug)\\b.*\\b(${AGENT_NOUNS})\\b`, "is");
// "i want / need / would like … <a feature to build>" — a request to build, even
// without an explicit build verb ("i want /profile to have a feedback form").
const WANT_FEATURE_RE = new RegExp(`\\b(want|need|wanna|would\\s+like|let'?s|can\\s+you|could\\s+you|please)\\b[^]*\\b(${AGENT_NOUNS}|added?|working|to\\s+have|so\\s+that)\\b`, "is");

// A bare go-ahead after the assistant proposed a change — "apply them yourself",
// "do it", "go ahead", "yes proceed". No build noun/verb needed; this is a
// continuation of an existing build conversation, not a new topic.
const CONFIRM_ACTION_RE = /\b(apply\s+(it|that|them|this|the\s+\w+)\b|do\s+it(\s+yourself)?\b|go\s+ahead\b|please\s+(do|proceed|implement|apply)\b|just\s+do\s+it\b|make\s+the\s+change|implement\s+it\b|^(yes|yep|yeah|sure|ok|okay)[,.]?\s*(proceed|go\s+ahead|do\s+it)\b|^proceed\b)/i;

// Unmistakable questions with no edit signal.
const OBVIOUS_QUESTION_RE = /^(what|how|why|when|where|who|which|can you explain|could you explain|explain|describe|tell me about|walk me through|summarize|summarise)\b[^]*\?\s*$/i;

// A "how/what/…?" question can still require real workspace state to answer
// well — "how do I run my server on port 5432" needs package.json, not a
// generic multi-framework cheat sheet. Force-routing every question to
// "answer" (which has no file/bash tools at all) is what produces that
// generic-answer failure. If the question also contains action language, let
// it fall through past this fast-path instead of committing to "answer" here
// — WANT_FEATURE_RE / CONFIRM_ACTION_RE / the LLM fallback below can still
// route it correctly (the LLM classifier's own instructions already treat
// "something run or installed" as "agent").
const ACTION_QUESTION_RE = /\b(run|start|serve|launch|host|deploy|install|build|execute|open|kill|stop|restart|configure|set\s*up)\b/i;

const FILE_REF_RE = /\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|ya?ml|html|py)\b|\b(src|app|components?|pages?|routes?|lib|hooks?|backend1?|chatbot)\//i;

// ── Workspace queries ────────────────────────────────────────────────────────
//
// "where is the CLI stored?" is a QUESTION, so OBVIOUS_QUESTION_RE below used
// to send it to the answer node — which has no file tools at all and would
// reply "I don't have visibility into your actual project files". But its
// answer depends entirely on this workspace, so it belongs on the tool path.
//
// These are deliberately semantic (a locator + a code/project noun, or an
// explicit "this project / my repo" reference), not a list of phrasings, so
// wording variations still classify correctly. General-knowledge questions
// ("what is React?", "explain closures") match none of them and stay on the
// cheap answer path.

// "where is …", "which file …", "find …", "show me …" — asking for a location.
const LOCATOR_RE = /\b(where(?:'s|\s+(?:is|are|does|do|can\s+i\s+find|should\s+i\s+look))?|which\s+(?:one\s+)?(?:file|files|folder|directory|module|component|function|class|route|endpoint|script|package|part)|what\s+(?:file|files|folder|directory|module|component|function|class|route|endpoint|script|package)|locate|find|show\s+me|list|inspect|search)\b/i;

// Nouns that only exist inside a codebase/workspace.
const CODE_NOUN_RE = /\b(cli|files?|folders?|director(?:y|ies)|repo|repository|codebase|code\s?base|workspace|project|package\.json|manifest|structure|entry\s*points?|modules?|components?|functions?|classe?s?|routes?|endpoints?|api|configs?|configuration|scripts?|tests?|imports?|dependenc(?:y|ies)|source|src|server|database|schema|migrations?|agent\s+loop|router|middleware|hooks?|env|environment\s+variables?|frontend|backend|stack|framework|logic|implementation|definition|handlers?|controllers?|services?|pages?|views?|screens?|layouts?|stores?|providers?|types?|interfaces?|constants?|styles?)\b/i;

// "where is X implemented/defined/stored/configured" — a here-and-now question
// about this codebase even when no code noun is named.
const IMPL_RE = /\b(implemented|defined|declared|located|stored|configured|set\s*up|structured|organi[sz]ed|wired|registered|handled|rendered|exported|imported|installed|used\s+(?:here|in\s+this)|live[sd]?)\b/i;

// Explicit deixis: "this project", "my repo", "in here", "does this app use".
const PROJECT_DEIXIS_RE = /\b(my|our|this|the)\s+(project|repo|repository|codebase|code\s?base|workspace|app|application)\b|\b(this|my|our)\s+(file|folder|directory|component|module|function|route|server|frontend|backend)\b|\b(in|inside)\s+(here|this\s+(project|repo|repository|codebase|folder|directory))\b/i;

// "how is the frontend structured?" — no locator word, still workspace-bound.
const HOW_HERE_RE = /\bhow\s+(is|are|does|do|did)\b[^]*\b(structured|organi[sz]ed|implemented|configured|set\s*up|wired|laid\s*out|defined|arranged|split)\b/i;

/**
 * True when answering the message requires inspecting THIS workspace —
 * its files, directories, source, config, structure, or repository state.
 *
 * Exported for direct unit testing (see tests/router.test.mjs) and so callers
 * can log the classification without re-deriving it.
 */
export function isWorkspaceQuery(message) {
  const msg = String(message || "").trim();
  if (!msg) return false;
  if (PROJECT_DEIXIS_RE.test(msg)) return true;
  if (HOW_HERE_RE.test(msg)) return true;
  if (FILE_REF_RE.test(msg)) return true;
  if (LOCATOR_RE.test(msg) && (CODE_NOUN_RE.test(msg) || IMPL_RE.test(msg))) return true;
  return false;
}

async function classifyWithLLM(message, modelRoute) {
  try {
    const { callLLM } = await import("../../services/llm.mjs");
    const cleanMsg = String(message || "").split(/conversation memory:/i)[0].trim().slice(0, 600);
    const result = await callLLM({
      system: `Classify the user's message as exactly one word.
"answer" — a question, explanation request, or conversation. No files should change.
"agent" — the user wants code changed, files created, a bug fixed, something run or installed, or any work performed in the workspace.
Respond with ONLY the word "answer" or "agent".`,
      messages: [{ role: "user", content: cleanMsg }],
      modelRoute,
      maxTokens: 5,
      temperature: 0,
      // A one-word classification gains nothing from reasoning — explicit,
      // since some providers (Qwen3) default extended thinking ON server-side
      // when a request doesn't say otherwise, taxing every single message.
      thinking: false,
    });
    const raw = String(result?.content || "").trim().toLowerCase();
    if (raw.includes("agent")) return "agent";
    if (raw.includes("answer")) return "answer";
  } catch (err) {
    console.warn("[Router] LLM classification failed:", String(err?.message || err).slice(0, 120));
  }
  // On failure, prefer the agent: it can answer questions too, while the answer
  // node can never make a requested edit.
  return "agent";
}

// Local, network-free classification from the regex chain alone.
// Returns "agent" | "answer" | null (null = ambiguous — caller falls back to
// the remembered-target-file check, then the LLM classifier). Exported so
// this can be unit tested directly without a live LLM call.
export function classifyFastPath(cleanMsg) {
  if (!cleanMsg || GREETING_RE.test(cleanMsg)) return "answer";
  if (NO_ACTION_RE.test(cleanMsg)) return "answer";
  if (OBVIOUS_AGENT_RE.test(cleanMsg) || (FILE_REF_RE.test(cleanMsg) && !OBVIOUS_QUESTION_RE.test(cleanMsg))) return "agent";
  // Before the question fast-path: a question whose ANSWER lives in the
  // workspace needs file tools, which only the agent path has.
  if (isWorkspaceQuery(cleanMsg)) return "agent";
  if (OBVIOUS_QUESTION_RE.test(cleanMsg) && !ACTION_QUESTION_RE.test(cleanMsg)) return "answer";
  // "i want /profile to have a feedback form" — a build request phrased as a wish.
  if (WANT_FEATURE_RE.test(cleanMsg)) return "agent";
  // "apply them yourself" / "do it" / "go ahead" — a go-ahead on a change the
  // assistant just proposed. Never treat this as small talk to answer.
  if (CONFIRM_ACTION_RE.test(cleanMsg)) return "agent";
  return null;
}

export async function routerNode(state) {
  const { userMessage, modelRoute, emit, rememberedTargetFile } = state;
  const cleanMsg = String(userMessage || "").split(/conversation memory:/i)[0].trim();

  let intent = classifyFastPath(cleanMsg);
  if (intent === null) {
    if (rememberedTargetFile && /\b(that\s+(page|file|component)|on\s+it|to\s+it|in\s+it|it\s+again)\b/i.test(cleanMsg)) {
      intent = "agent";
    } else {
      intent = await classifyWithLLM(cleanMsg, modelRoute);
    }
  }

  const workspaceQuery = intent === "agent" && isWorkspaceQuery(cleanMsg);
  console.log(
    `[Router] intent="${intent}"${workspaceQuery ? " kind=workspace_query" : ""} ` +
    `workspace="${state.workspacePath || "(none)"}" for: "${cleanMsg.slice(0, 80)}"`,
  );
  emit?.({
    type: "progress",
    stage: "routed",
    message: intent === "agent" ? "🤖 Agent mode — working in your workspace..." : "💬 Preparing response...",
  });

  return { intent };
}
