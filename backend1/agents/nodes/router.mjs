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
  /^(what|how|why|when|where|who|which|can you|could you|would you|do you|is it|are you|should i|explain|describe|tell me)/i,
  /\b(what is|what are|how do|how does|how can|why does|why is|explain|describe|difference between|pros and cons|best practice|recommend)\b/i,
];

const INSTALL_PATTERNS = [
  /\b(install|add)\s+(@[\w][\w\-./@]*|[\w][\w]*[-./][\w][\w\-./@]*)/i,
  /\bnpm\s+(install|i)\b/i,
  /\byarn\s+add\b/i,
  /\bpnpm\s+add\b/i,
  /\badd\s+(shadcn|shadcn-ui|tailwind|radix|react-query|zustand|prisma|axios|zod|framer|lucide)\b/i,
  /\binstall\s+(shadcn|package|packages|dependency|dependencies)\b/i,
  /\bshadcn\b.*\b(add|install|button|card|dialog|form|input|table|badge|avatar|select|dropdown|modal|sheet|toast|sidebar)\b/i,
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
  /\b(codex|cursor|claude code)\b/i,
];

const FILE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|json|md|ya?ml|html|xml|env|sh|py|rs|go|png|jpe?g|gif|svg|webp|ico)\b/i;
const FILE_PATH = /\b(src\/|app\/|components?\/|pages?\/|routes?\/|lib\/|utils?\/|hooks?\/|api\/|services?\/|public\/|styles?\/)\S+/i;
const COMPONENT_NAME = /\b(chatsidebar|chatheader|chatcomposer|agentpipeline|thinkingtrace|authguard|emptystatecard|typingindicator|assistantmessage|useagenthook|usethinkingsteps|planchanges|kodo_graph|graph_runner|workingset|modelrouter)\b/i;
const CODE_EDIT_VERB = /\b(create|write|generate|build|refactor|rewrite|implement|scaffold|migrate|lint|typecheck|import|export|instantiate|destructure|annotate)\b/i;
const EDIT_VERB = /\b(remove|delete|add|change|make|update|fix|rename|move|edit|modify|replace|adjust|tweak|set|put|insert|clear|hide|show|toggle|disable|enable|style|color|colour|animate|resize|rotate|translate|scale)\b/i;

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

function isDebugReport(msg) {
  return (
    DEBUG_HINTS.some((p) => p.test(msg)) ||
    /\b(fix|bug|error|crash|broken|failed|exception)\b/i.test(msg)
  );
}

function classifyByHeuristic(message) {
  const msg = String(message || "").trim();
  if (!msg) return "answer";

  const cleanMsg = msg.split(/conversation memory:/i)[0].trim();
  if (!cleanMsg) return "answer";

  const wordCount = cleanMsg.split(/\s+/).filter(Boolean).length;

  for (const p of GREETING_PATTERNS) {
    if (p.test(cleanMsg)) return "answer";
  }

  for (const p of PIPELINE_PATTERNS) {
    if (p.test(cleanMsg)) return "pipeline";
  }

  const isQuestion = QUESTION_PATTERNS.some((p) => p.test(cleanMsg));

  if (INSTALL_PATTERNS.some((p) => p.test(cleanMsg))) return "install";
  if (TEST_PATTERNS.some((p) => p.test(cleanMsg))) return "test";
  if (isDebugReport(cleanMsg)) return "investigate";

  const hasFileExtension = FILE_EXTENSION.test(cleanMsg);
  const hasFilePath = FILE_PATH.test(cleanMsg);
  const hasComponentName = COMPONENT_NAME.test(cleanMsg);
  const hasCodeEditVerb = CODE_EDIT_VERB.test(cleanMsg);

  if (hasFileExtension) return "explore";
  if (hasFilePath) return "explore";
  if (hasComponentName) return "explore";
  if (hasCodeEditVerb) return "explore";

  if (wordCount <= 15 && EDIT_VERB.test(cleanMsg) && !isQuestion) {
    return "explore";
  }

  if (wordCount <= 8 && !hasFileExtension && !hasFilePath) return "answer";
  if (isQuestion) return "answer";

  return "answer";
}

const CONTEXTUAL_EDIT_RE = /\b(that\s+(page|file|function|component|module|class|script)|on\s+it|to\s+it|in\s+it)\b/i;

export async function routerNode(state) {
  const { userMessage, emit, rememberedTargetFile } = state;

  let intent = classifyByHeuristic(userMessage);

  // If heuristic says "answer" but there's a remembered file and the user
  // refers to it contextually ("that page", "on it", etc.), treat as an edit.
  if (intent === "answer" && rememberedTargetFile) {
    const cleanMsg = String(userMessage).split(/conversation memory:/i)[0].trim();
    if (CONTEXTUAL_EDIT_RE.test(cleanMsg)) {
      intent = "explore";
    }
  }
  console.log(`[Router] intent="${intent}" for: "${String(userMessage).slice(0, 80)}"`);

  emit?.({
    type: "progress",
    stage: "routed",
    message:
      intent === "investigate" ? "🧠 Starting investigation mode..." :
      intent === "explore" ? "📂 Entering workspace mode..." :
      intent === "pipeline" ? "🚀 Starting full pipeline..." :
      intent === "test" ? "🧪 Running tests..." :
      intent === "install" ? "📦 Installing packages..." :
      "💬 Preparing response...",
  });

  return { intent };
}