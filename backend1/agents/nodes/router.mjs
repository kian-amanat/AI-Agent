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

const FILE_REF_RE = /\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|ya?ml|html|py)\b|\b(src|app|components?|pages?|routes?|lib|hooks?|backend1?|chatbot)\//i;

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

export async function routerNode(state) {
  const { userMessage, modelRoute, emit, rememberedTargetFile } = state;
  const cleanMsg = String(userMessage || "").split(/conversation memory:/i)[0].trim();

  let intent;
  if (!cleanMsg || GREETING_RE.test(cleanMsg)) {
    intent = "answer";
  } else if (NO_ACTION_RE.test(cleanMsg)) {
    intent = "answer";
  } else if (OBVIOUS_AGENT_RE.test(cleanMsg) || (FILE_REF_RE.test(cleanMsg) && !OBVIOUS_QUESTION_RE.test(cleanMsg))) {
    intent = "agent";
  } else if (OBVIOUS_QUESTION_RE.test(cleanMsg)) {
    intent = "answer";
  } else if (WANT_FEATURE_RE.test(cleanMsg)) {
    // "i want /profile to have a feedback form" — a build request phrased as a wish.
    intent = "agent";
  } else if (CONFIRM_ACTION_RE.test(cleanMsg)) {
    // "apply them yourself" / "do it" / "go ahead" — a go-ahead on a change the
    // assistant just proposed. Never treat this as small talk to answer.
    intent = "agent";
  } else if (rememberedTargetFile && /\b(that\s+(page|file|component)|on\s+it|to\s+it|in\s+it|it\s+again)\b/i.test(cleanMsg)) {
    intent = "agent";
  } else {
    intent = await classifyWithLLM(cleanMsg, modelRoute);
  }

  console.log(`[Router] intent="${intent}" for: "${cleanMsg.slice(0, 80)}"`);
  emit?.({
    type: "progress",
    stage: "routed",
    message: intent === "agent" ? "🤖 Agent mode — working in your workspace..." : "💬 Preparing response...",
  });

  return { intent };
}
