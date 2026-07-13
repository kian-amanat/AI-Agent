/**
 * router.mjs
 * Heuristic intent router.
 * "investigate" → bug/debug/root-cause workflow
 * "explore"     → normal workspace edit flow
 * "pipeline"    → full app / feature flow
 * "answer"      → everything else
 */

const GREETING_PATTERNS = [
  /^(hi|hello|hey|سلام|مرحبا|hola|bonjour|ciao|yo|sup|howdy|greetings|salut|hiya|heya)[!.,\s]*$/i,
  /^(how are you|how's it going|what's up|whats up|good morning|good evening|good afternoon|good night)/i,
  /^(thanks|thank you|thx|ty|ممنون|مرسی|cheers|appreciate it|great job|nice work|well done)[!.,\s]*$/i,
  /^(ok|okay|got it|understood|sure|alright|sounds good|perfect|great|cool|nice|awesome|👍)[!.,\s]*$/i,
  /^(bye|goodbye|see you|later|cya|take care)[!.,\s]*$/i,
  /^(who are you|what are you|what('s| is) your name|tell me about yourself)[?!.,\s]*$/i,
  /^(what (model|ai|llm) (are you|is this)|your model name)[?!.,\s]*/i,
];

const QUESTION_PATTERNS = [
  /^(what|how|why|when|where|who|which|can you|could you|would you|do you|is it|are you|should i|explain|describe|tell me|summarize|summarise|summary|overview|walk me|guide me)/i,
  /\b(what is|what are|how do|how does|how can|why does|why is|explain|describe|difference between|pros and cons|best practice|recommend|summarize|summarise|summary of|i want to know|i need to know|tell me about|walk me through)\b/i,
];

// User explicitly signals they do NOT want code changes — must win over all other signals.
const NO_ACTION_PATTERNS = [
  /\b(just\s+tell\s+me|only\s+tell\s+me|just\s+explain|only\s+explain|just\s+describe|just\s+show\s+me)\b/i,
  /\bwithout\s+(any\s+)?(action|edit|editing|change|changing|modification|modifying|touching|doing\s+anything)\b/i,
  /\bdon'?t\s+(edit|change|modify|touch|do|make|apply|write|create|delete|remove)\b/i,
  /\b(no\s+changes?|no\s+action|no\s+edit|no\s+code)\b/i,
  /\b(should\s+i|do\s+you\s+think|what\s+do\s+you\s+think|is\s+(it|this|now)\s+(a\s+good|the\s+right)\s+time)\b/i,
];

const INSTALL_PATTERNS = [
  // Generic: scoped packages (@scope/name) OR hyphenated names (react-dom, framer-motion).
  // Dot-separated names like "ref.current.signal" are excluded — dots mean property access, not packages.
  /\b(install|add)\s+@[\w][\w\-./@]*/i,
  /\b(install|add)\s+[a-z][\w]*-[a-z][\w\-/]*/i,
  /\bnpm\s+(install|i)\b/i,
  /\byarn\s+add\b/i,
  /\bpnpm\s+add\b/i,
  /\badd\s+(shadcn|shadcn-ui|tailwind|radix|react-query|zustand|prisma|axios|zod|framer|lucide)\b/i,
  /\binstall\s+(shadcn|package|packages|dependency|dependencies)\b/i,
  /\bshadcn\b.*\b(add|install|button|card|dialog|form|input|table|badge|avatar|select|dropdown|modal|sheet|toast|sidebar)\b/i,
  // "install X" with a single word — "install" is almost never an edit verb, so any bare package name qualifies
  /\binstall\s+(?!a\b|an\b|the\b|some\b|all\b)([a-z][a-z0-9]{2,})\b/i,
  // "add X" for common single-word npm packages that have no hyphen
  /\badd\s+(lodash|dayjs|uuid|clsx|nanoid|immer|jotai|valtio|rxjs|mobx|recoil|swr|express|fastify|mongoose|drizzle|redis|cors|helmet|morgan|winston|pino|nodemailer|bcrypt|passport|multer|cheerio|puppeteer|jest|vitest|mocha|prettier|eslint|husky|esbuild|turbo|dotenv|rimraf|concurrently|socket|marked|chokidar|glob|mime|sharp|stripe|twilio|chalk|yargs|commander|inquirer|ora|debug|semver|handlebars|mustache|nunjucks|pug|ejs|joi|yup|serialize)\b/i,
];

const TEST_PATTERNS = [
  /\b(run|execute|start|trigger)\s+(the\s+)?(tests?|test suite|unit tests?|integration tests?)\b/i,
  /\b(npm\s+test|npm\s+run\s+test)\b/i,
  /\bdo (the\s+)?tests? (pass|work|run|fail)\b/i,
  /\b(check|verify)\s+(if\s+)?(tests?|specs?)\s+(pass|work|are ok)\b/i,
  /^(test|tests|run tests?|check tests?)[\s!?]*$/i,
];

const PIPELINE_PATTERNS = [
  /\b(build|scaffold|develop)\s+(a\s+)?(full|complete|entire|whole)\s+(app|project|system|platform|website|application)\b/i,
  /\b(create|make|generate)\s+(a\s+)?(full.?stack|end.?to.?end)\b/i,
  /\b(start|create|build)\s+(my\s+)?(ai\s+)?agent\b/i,
  // "codex" alone is a reliable signal; "cursor" is NOT — UI prompts constantly say
  // "tilt toward the cursor" / "follows the cursor" (the mouse pointer). Require
  // tool-context around "cursor" so design language never routes to pipeline.
  /\bcodex\b/i,
  /\bcursor\s+(ai|ide|editor|agent|app)\b|\blike\s+cursor\b|\bcursor-style\b/i,
  /\b(build|create|scaffold|develop|make)\b.{0,30}\b(claude\s*code)\b/i,
];

const FILE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|json|md|ya?ml|html|xml|env|sh|py|rs|go|png|jpe?g|gif|svg|webp|ico)\b/i;
const FILE_PATH = /\b(src\/|app\/|components?\/|pages?\/|routes?\/|lib\/|utils?\/|hooks?\/|api\/|services?\/|public\/|styles?\/)\S+/i;
const COMPONENT_NAME = /\b(chatsidebar|chatheader|chatcomposer|agentpipeline|thinkingtrace|authguard|emptystatecard|typingindicator|assistantmessage|useagenthook|usethinkingsteps|planchanges|kodo_graph|graph_runner|workingset|modelrouter|settings?|settingbutton|settingspanel|settingsmodal|chatinput|inputarea|sendbutton|composer)\b/i;
const CODE_EDIT_VERB = /\b(create|write|generate|build|refactor|rewrite|implement|scaffold|migrate|lint|typecheck|import|export|instantiate|destructure|annotate|center|align|position|margin|padding|spacing|layout|flex|grid|border|shadow|opacity|transition|animations?|hover|design|minimal|rounded|cursor|icon|button|badge|pill|chip|card|modal|dropdown|tooltip|sidebar|navbar|header|footer|theme|dark|light|gradient|blur|backdrop|ring|outline|underline|bold|italic|font|text|size|width|height|gap|wrap|overflow|scroll|sticky|fixed|absolute|relative|z-index|radius|rotate|scale|translate|skew|clip|mask|filter|brightness|contrast|saturate|invert)\b/i;
const EDIT_VERB = /\b(remove|delete|add|change|make|update|fix|rename|move|edit|modify|replace|adjust|tweak|set|put|insert|clear|hide|show|toggle|disable|enable|style|color|colour|animate|resize|rotate|translate|scale|improve|enhance|beautify|polish|refine|simplify|clean|smooth|soften|sharpen|brighten|darken|lighten)\b/i;

const DEBUG_HINTS = [
  /bad request/i,
  /stack trace/i,
  /trace/i,
  /typeerror/i,
  /referenceerror/i,
  /syntaxerror/i,
  /fstd_err_ctp_empty_json_body/i,
  /500/i,
  /404/i,
  /failed/i,
  /exception/i,
  /crash/i,
  /broken/i,
  /not working/i,
  /doesn't work/i,
  /doesn.t work/i,
  /while i delete/i,
  /delete session/i,
  /session delete/i,
  /api\/agent\/sessions/i,
  /sessions\//i,
];

function isMultiTaskRequest(msg) {
  const m = String(msg || "");
  // Numbered list: "1. ...", "**1. ...", "1- ...", "1) ..."
  const numberedItem = /(?:^|[\n\r])\s*(?:\*{1,2})?[1-5][.\-\)]\s*\S/;
  const secondItem   = /(?:^|[\n\r])\s*(?:\*{1,2})?[2-5][.\-\)]\s*\S/;
  if (numberedItem.test(m) && secondItem.test(m)) return true;
  if (/\b1[.\-\)]\s*.{3,80}[,\n]?\s*2[.\-\)]\s*\S/s.test(m)) return true;
  // Explicit count words
  if (/\b(two|three|four|five|2|3|4|5)\s+(things?|changes?|tasks?|items?|fixes?|improvements?|updates?)\b/i.test(m)) return true;
  // Multiple conjunctions connecting distinct actions
  if (/\b(also|additionally|furthermore|moreover|plus|as well as|on top of that)\b/i.test(m)) return true;
  // Comma-separated actions with verbs — expanded to include give/show/display/set/enable
  if (/\b(create|make|add|fix|change|update|remove|improve|build|implement|design|move|refactor|rewrite|give|show|display|set|enable)\b.{3,80},\s+(?:and\s+)?\b(create|make|add|fix|change|update|remove|improve|build|implement|design|move|refactor|rewrite|give|show|display|set|enable)\b/i.test(m)) return true;
  // "Edit these 2 files", "update 3 files"
  if (/\b(edit|update|change|modify|fix)\s+(?:these\s+)?([2-9]|two|three|four|five)\s+files?\b/i.test(m)) return true;
  return false;
}

function isDebugReport(msg) {
  // "fix" alone is not a debug signal — feature requests say "fix the layout" all the time.
  // Only treat as debug when there are actual error indicators.
  return (
    DEBUG_HINTS.some((p) => p.test(msg)) ||
    /\b(bug|error|crash|broken|failed|exception)\b/i.test(msg)
  );
}

// Returns { intent, confident }. "confident" means a clear, well-tested signal fired —
// callers can trust it outright. When nothing but the bare fallback matched, confident
// is false: the message is genuinely ambiguous for regex (no file ref, no edit verb, no
// question phrasing) and callers should prefer an LLM judgment call over guessing "answer".
function classifyByHeuristicDetailed(message) {
  const msg = String(message || "").trim();
  if (!msg) return { intent: "answer", confident: true };

  const cleanMsg = msg.split(/conversation memory:/i)[0].trim();
  if (!cleanMsg) return { intent: "answer", confident: true };

  const wordCount = cleanMsg.split(/\s+/).filter(Boolean).length;

  for (const p of GREETING_PATTERNS) {
    if (p.test(cleanMsg)) return { intent: "answer", confident: true };
  }

  // Explicit no-action guard — user says "just tell me" / "without any changes" etc.
  if (NO_ACTION_PATTERNS.some((p) => p.test(cleanMsg))) return { intent: "answer", confident: true };

  // Numbered list (1- ... 2- ...) checked BEFORE pipeline patterns.
  // Pipeline patterns fire on keywords like "claude code" that appear in design references
  // ("make it look like claude code") — a numbered list is almost always a multi-task edit,
  // never a full-project scaffold, so it must win over pipeline classification.
  const numberedListItem = /(?:^|[\n\r])\s*(?:\*{1,2})?[1-5][.\-\)]\s*\S/;
  const numberedListSecond = /(?:^|[\n\r])\s*(?:\*{1,2})?[2-5][.\-\)]\s*\S/;
  if (numberedListItem.test(cleanMsg) && numberedListSecond.test(cleanMsg)) return { intent: "multi_task", confident: true };

  for (const p of PIPELINE_PATTERNS) {
    if (p.test(cleanMsg)) return { intent: "pipeline", confident: true };
  }

  // Strip leading @file mentions before checking question patterns — they're context
  // refs (not verbs), and the ^ anchor fails when the message leads with "@path/file.mjs".
  const intentMsg = cleanMsg.replace(/^(@[\w./\\-]+\s*)+/, "").trim() || cleanMsg;
  const isQuestion = QUESTION_PATTERNS.some((p) => p.test(intentMsg));

  // Multi-task requests with named files win over install/debug checks.
  // Route to multi_task_runner which uses LLM decomposition — not regex — to split tasks.
  const hasFileExtensionEarly = FILE_EXTENSION.test(cleanMsg);
  const hasComponentNameEarly = COMPONENT_NAME.test(cleanMsg);
  if (isMultiTaskRequest(cleanMsg) && (hasFileExtensionEarly || hasComponentNameEarly)) return { intent: "multi_task", confident: true };

  if (INSTALL_PATTERNS.some((p) => p.test(cleanMsg))) return { intent: "install", confident: true };
  if (TEST_PATTERNS.some((p) => p.test(cleanMsg))) return { intent: "test", confident: true };

  if (isDebugReport(cleanMsg)) return { intent: "investigate", confident: true };

  const hasFileExtension = FILE_EXTENSION.test(cleanMsg);
  const hasFilePath = FILE_PATH.test(cleanMsg);
  const hasComponentName = COMPONENT_NAME.test(cleanMsg);
  const hasCodeEditVerb = CODE_EDIT_VERB.test(cleanMsg);

  // Second multi-task check: catches patterns without a file extension in the early check
  if (isMultiTaskRequest(cleanMsg) && (hasFilePath || hasComponentName || hasCodeEditVerb || EDIT_VERB.test(cleanMsg))) return { intent: "multi_task", confident: true };

  if (hasFileExtension && !isQuestion) return { intent: "explore", confident: true };
  if (hasFilePath && !isQuestion) return { intent: "explore", confident: true };
  if (hasComponentName && !isQuestion) return { intent: "explore", confident: true };
  if (hasCodeEditVerb) return { intent: "explore", confident: true };

  if (wordCount <= 40 && EDIT_VERB.test(cleanMsg) && !isQuestion) {
    return { intent: "explore", confident: true };
  }

  if (wordCount <= 8 && !hasFileExtension && !hasFilePath) return { intent: "answer", confident: true };
  if (isQuestion) return { intent: "answer", confident: true };

  // Nothing matched — genuinely ambiguous (no file/component reference, no edit verb,
  // no question phrasing, too long to be a trivial chat message). Regex has no real
  // signal here; let the caller fall back to an LLM judgment instead of guessing.
  return { intent: "answer", confident: false };
}

function classifyByHeuristic(message) {
  return classifyByHeuristicDetailed(message).intent;
}

// LLM fallback for the genuinely ambiguous middle ground the regex heuristic can't
// resolve. Claude Code doesn't pre-classify at all — every message goes through the
// same agentic judgment. We can't afford an LLM call on every message (latency/cost
// for the ~95% of messages the regex handles confidently), but for the rare ambiguous
// case, one cheap classification call beats silently defaulting to "answer" and missing
// an edit request, or defaulting to "explore" and running a needless write pipeline.
async function classifyIntentWithLLM(message, modelRoute) {
  try {
    const { callLLM } = await import("../../services/llm.mjs");
    const cleanMsg = String(message || "").split(/conversation memory:/i)[0].trim().slice(0, 500);

    const result = await callLLM({
      system: `Classify the user's message as exactly one word: "answer" or "explore".
"answer" — the user is asking a question, wants an explanation, or is making conversation. No files should be changed.
"explore" — the user wants code changed, a bug fixed, or a feature added/modified in the codebase.
Respond with ONLY the single word "answer" or "explore" — nothing else.`,
      messages: [{ role: "user", content: cleanMsg }],
      modelRoute,
      maxTokens: 5,
      temperature: 0,
    });

    const raw = String(result?.content || "").trim().toLowerCase();
    if (raw.includes("explore")) return "explore";
    if (raw.includes("answer")) return "answer";
  } catch (err) {
    console.warn("[Router] LLM fallback classification failed:", String(err?.message || err).slice(0, 120));
  }
  // If the LLM call itself fails, keep the heuristic's own default rather than crash routing.
  return "answer";
}

const CONTEXTUAL_EDIT_RE = /\b(that\s+(page|file|function|component|module|class|script)|on\s+it|to\s+it|in\s+it)\b/i;

export async function routerNode(state) {
  const { userMessage, emit, rememberedTargetFile, modelRoute } = state;

  const heuristic = classifyByHeuristicDetailed(userMessage);
  let intent = heuristic.intent;

  if (!heuristic.confident) {
    console.log(`[Router] Heuristic uncertain for: "${String(userMessage).slice(0, 80)}" — falling back to LLM classification`);
    intent = await classifyIntentWithLLM(userMessage, modelRoute);
  }

  // If heuristic says "answer" but there's a remembered file and the user
  // refers to it contextually ("that page", "on it", etc.), treat as an edit.
  if (intent === "answer" && rememberedTargetFile) {
    const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();
    if (CONTEXTUAL_EDIT_RE.test(cleanMsg)) {
      intent = "explore";
    }
  }
  console.log(`[Router] intent="${intent}"${heuristic.confident ? "" : " (LLM fallback)"} for: "${String(userMessage).slice(0, 80)}"`);

  emit?.({
    type: "progress",
    stage: "routed",
    message:
      intent === "investigate" ? "🧠 Starting investigation mode..." :
      intent === "explore"     ? "📂 Entering workspace mode..." :
      intent === "pipeline"    ? "📂 Entering workspace mode..." :
      intent === "multi_task"  ? "🧩 Multi-task mode — decomposing..." :
      intent === "test"        ? "🧪 Running tests..." :
      intent === "install"     ? "📦 Installing packages..." :
      "💬 Preparing response...",
  });

  return { intent };
}