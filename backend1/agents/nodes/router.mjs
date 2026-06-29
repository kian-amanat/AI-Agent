/**
 * router.mjs — NO LLM, pure heuristics.
 * "explore"  → read / edit / create / delete project files
 * "pipeline" → build a full new app from scratch
 * "answer"   → greetings, Q&A, explanations
 */

const GREETING_PATTERNS = [
  /^(hi|hello|hey|سلام|مرحبا|hola|bonjour|ciao|yo|sup|howdy)[!.,\s]*$/i,
  /^(how are you|how's it going|what's up|whats up|good morning|good evening|good afternoon)/i,
  /^(thanks|thank you|thx|ممنون|مرسی|cheers)[!.,\s]*$/i,
  /^(ok|okay|got it|understood|sure|alright|sounds good)[!.,\s]*$/i,
];

const PIPELINE_PATTERNS = [
  /\b(build|scaffold|develop)\s+(a\s+)?(full|complete|entire|whole)\s+(app|project|system|platform|website|application)\b/i,
  /\b(create|make|generate)\s+(a\s+)?(full.?stack|end.?to.?end)\b/i,
];

// Files of any kind — code, images, styles, config
const FILE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|json|md|ya?ml|html|xml|env|sh|py|rs|go|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|pdf)\b/i;

// Common component/file names that appear WITHOUT an extension
const COMPONENT_NAME = /\b(sidebar|navbar|header|footer|button|modal|dialog|card|layout|page|composer|chatbox|chatsidebar|chatheader|message|avatar|dropdown|menu|tooltip|badge|input|form|table|list|grid|panel|drawer|tab|accordion|carousel|slider|toggle|switch|checkbox|radio|select|textarea|spinner|loader|toast|alert|banner|hero|section|container|wrapper|provider|context|hook|util|helper|service|store|reducer|action|route|controller|model|schema|config|middleware)\b/i;

const EXPLORE_PATTERNS = [
  // any file extension present
  FILE_EXTENSION,
  // directory references
  /\b(src\/|app\/|components?\/|pages?\/|routes?\/|lib\/|utils?\/|hooks?\/|api\/|services?\/|config\/|public\/|styles?\/|assets?\/)/i,
  // read operations
  /\b(read|open|show|display|print|list|find|search|look at|check|inspect|view)\b.{0,40}\b(file|files|folder|directory|dir|code|content|source|component|page|function)\b/i,
  // write / modify operations (broad)
  /\b(edit|update|modify|change|fix|refactor|rename|rewrite|replace|patch|adjust|tweak|alter|set|make|add|remove|delete|increase|decrease|resize|enlarge|shrink|move|style|color|colour)\b/i,
  // create operations
  /\b(create|add|write|generate|scaffold|new)\b.{0,30}\b(file|component|page|route|module|class|function|hook|service|util|helper|test|spec|style)\b/i,
  // workspace references
  /\b(my (project|workspace|codebase|repo|files|code|app|component|sidebar)|in (the |my )?(project|workspace|codebase|repo|sidebar|component|file))\b/i,
  /\b(what('s| is) in|content of|show me the)\b/i,
];

function classifyByHeuristic(message) {
  const msg = String(message || "").trim();
  if (!msg) return "answer";

  // Strip the "Conversation memory:" suffix the route appends, so it
  // doesn't pollute routing
  const cleanMsg = msg.split(/conversation memory:/i)[0].trim();

  // Greetings → answer
  for (const p of GREETING_PATTERNS) {
    if (p.test(cleanMsg)) return "answer";
  }

  // Pipeline check first (full builds)
  for (const p of PIPELINE_PATTERNS) {
    if (p.test(cleanMsg)) return "pipeline";
  }

  // Strong signal: a filename, file extension, or known component name
  // combined with anything → explore
  const hasFile      = FILE_EXTENSION.test(cleanMsg);
  const hasComponent = COMPONENT_NAME.test(cleanMsg);

  // Action verbs that imply editing code
  const hasEditVerb = /\b(edit|update|modify|change|fix|refactor|rename|rewrite|replace|patch|adjust|tweak|alter|make|add|remove|delete|increase|decrease|resize|enlarge|shrink|move|bigger|smaller|larger|style|color|colour|background|padding|margin|width|height|font|border|round|shadow)\b/i.test(cleanMsg);

  // If they mention a file/component AND want to do something → explore
  if ((hasFile || hasComponent) && hasEditVerb) return "explore";

  // If they just mention a file/component at all → explore (likely want to read/edit)
  if (hasFile) return "explore";

  // Run the full explore pattern list
  for (const p of EXPLORE_PATTERNS) {
    if (p.test(cleanMsg)) return "explore";
  }

  // Short greeting-like messages with no file signal → answer
  const wordCount = cleanMsg.split(/\s+/).length;
  if (wordCount < 6 && !hasComponent) return "answer";

  // Default
  return "answer";
}

export async function routerNode(state) {
  const { userMessage, emit } = state;

  const intent = classifyByHeuristic(userMessage);

  console.log(`[Router] intent="${intent}" for: "${String(userMessage).slice(0, 80)}"`);

  emit?.({
    type:    "progress",
    stage:   "routed",
    message:
      intent === "explore"  ? "📂 Entering workspace mode..." :
      intent === "pipeline" ? "🚀 Starting full pipeline..." :
                              "💬 Preparing response...",
  });

  return { intent };
}
