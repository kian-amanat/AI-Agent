/**
 * services/taskController.mjs
 *
 * The agent's task state machine: inspect → plan → patch → verify → finish.
 *
 * WHY THIS EXISTS
 * The tool loop is good at taking the next step but has no memory of whether
 * the last several steps were the SAME step. That produces two failures:
 *
 *   1. Thrashing — the same class of fix retried against the same file, most
 *      visibly on TypeScript/JSX errors, where each edit changes a type
 *      annotation, the error moves, and the next edit changes it back.
 *   2. Finishing unverified — declaring success after edits that were never
 *      typechecked, tested or built.
 *
 * This controller is a pure, deterministic observer. It executes nothing and
 * calls no model: the loop reports what happened, and the controller answers
 * two questions — "may this run finish?" and "is this path stuck?" — returning
 * a directive when the answer requires intervention.
 *
 * Determinism is deliberate. Every decision is a function of the recorded
 * history, so the same sequence of tool calls always yields the same verdict
 * and a failure is reproducible from the transcript alone.
 */

// A fix "class" is the unit of repetition: the same tool acting on the same
// file. Two edits to `Button.tsx` are the same class; editing `Button.tsx`
// then `api.ts` is not.
import { createHash } from "crypto";

const MUTATING_TOOLS = new Set(["edit_file", "write_file"]);

// Tools that gather information. A turn spent entirely on these is productive
// only if it surfaced something not already seen.
// Kept in sync with the loop's actual tool list. A reading tool missing from
// here earns NO credit, so a turn spent on it looks like a dead turn — which
// is how an agent doing ordinary reconnaissance gets stopped for "no progress".
const INSPECTING_TOOLS = new Set([
  "read_file", "grep", "glob", "list_files", "web_search", "fetch_url",
  // Reading of other kinds: background shell output, a skill's text, the
  // memory store, an MCP resource. All are information the agent did not have.
  "bash_output", "load_skill", "read_memory_topic", "list_memory_topics",
  "read_mcp_resource",
]);

// Tools that change the workspace by other means than a tracked file write.
// `review_patch` is deliberately NOT here: it only mutates under
// `action: "approve"`. Reading a subagent's diff — or REJECTING it — leaves the
// workspace untouched, and counting either as a change let a run satisfy
// "you must actually implement this" by looking at a patch and throwing it away.
const PATCH_TOOLS = new Set(["apply_patch"]);

// Shell commands that modify the tree. Requirement: a shell command that
// changes files counts as a real mutation, so scaffolding via `npx create-*`
// or moving files with `mv` is not mistaken for "did nothing".
// The redirect clause is the delicate one. `>>?\s*\S` matched `2>&1` and
// `2>/dev/null` — punctuation that appears on almost every shell command —
// so merely RUNNING THE TESTS registered as changing the workspace, and an
// agent could satisfy "implement this feature" without writing a line of code.
// A redirect now counts only when it names a real destination: not a file
// descriptor (`>&2`), not the bit bucket, and not preceded by a digit.
const FILE_MUTATING_BASH_RE =
  /(^|[\s;&|])(mkdir|touch|mv|cp|rm|rmdir|ln|chmod|sed\s+-i|tee|patch|unzip|tar\s+-x)\b|(?<![0-9&])>>?\s*(?!&|\/dev\/null)[^\s&|;<>]+|\bgit\s+(apply|checkout|restore|mv|rm|revert|cherry-pick|stash\s+pop)\b|\bnpx?\s+.*\b(create|init|generate|scaffold|add)\b|\b(npm|yarn|pnpm)\s+(init|install|add|remove|uninstall)\b/i;

// ── Execution intent ────────────────────────────────────────────────────────
// "Add a loading skeleton" is an instruction to change the repository.
// "Explain this component" is not. Getting this boundary right is the whole
// feature: too loose and ordinary questions get trapped in a loop demanding
// edits that were never wanted; too tight and the agent keeps printing code
// into the chat instead of writing it to disk.

// Imperative verbs that mean "change my project".
// `resume`/`finish`/`complete` matter as much as `add`: picking up half-built
// work is one of the most common real instructions, and without them a request
// like "resume the partial command palette implementation" carried no
// obligation to change anything — so the agent could read the repo, describe
// what remained, and stop, which is precisely the reported failure.
const ACTION_VERB_RE = /\b(add|create|implement|build|make|write|fix|refactor|rewrite|update|change|modify|remove|delete|rename|move|migrate|install|wire|integrate|apply|replace|extract|convert|port|scaffold|generate|resume|continue|finish|complete|restore|upgrade|optimi[sz]e|set\s+up|hook\s+up|clean\s+up)\b/i;

// Explicit "explain, don't touch" phrasing. Checked BEFORE the action verbs,
// because "explain how you would refactor this" contains a verb but is a
// question. A leading interrogative counts too.
// The trailing alternation catches modal-led questions — "should I continue
// using zod?" — which the broadened verb list would otherwise read as an
// instruction to go and change something. It is restricted to first-person and
// impersonal subjects on purpose: "can YOU add a dark mode toggle?" is a
// polite imperative, not a question, and must still require a mutation.
const EXPLAIN_RE = /\b(explain|describe|walk me through|tell me about|summari[sz]e|analy[sz]e|review|understand|clarify)\b|^\s*(what|why|which|who|where)\b|\bhow (does|do|did|is|are|would|should|can)\b|^\s*(should|can|could|would|will|do|does|did|is|are|am)\s+(i|we|it|this|that|there|they)\b[^?]*\?/i;

// "Just show me the code" / "don't edit anything" — an explicit opt-out that
// must always win over an action verb sitting next to it.
const CODE_ONLY_RE = /\b(just\s+(show|give|tell|paste|write out)|don'?t\s+(edit|change|modify|touch|write|create|apply|implement)|show me the code|give me the code|what'?s the code|example of|snippet|without (editing|changing|modifying))\b/i;

/**
 * Does this shell command change the project?
 *
 * Running the test suite is not implementing a feature, however it is piped or
 * redirected — so a verification command never counts, even when it writes a
 * log file. Without this, `npm test > out.log` satisfied "you must actually
 * change something".
 */
export function isMutatingCommand(command) {
  const c = String(command || "");
  if (!c.trim()) return false;
  if (VERIFY_COMMAND_RE.test(c)) return false;
  return FILE_MUTATING_BASH_RE.test(c);
}

/**
 * Does this request oblige the agent to modify the workspace?
 *
 * Deliberately stricter than the loop's advisory `looksBuildRequest`: that one
 * only triggers a soft nudge, so it can afford loose verbs like "want" or
 * "should". This one BLOCKS a final answer, so a false positive would trap a
 * genuine question in a re-execution loop. Different consequence, different
 * threshold.
 */
export function detectActionIntent(task) {
  const m = String(task || "");
  if (!m.trim()) return false;
  if (CODE_ONLY_RE.test(m)) return false;
  if (EXPLAIN_RE.test(m)) return false;
  return ACTION_VERB_RE.test(m);
}

const CODE_BLOCK_RE = /```/;

// ── Task shape ──────────────────────────────────────────────────────────────
// The single boolean "does this need a mutation" was too coarse to steer with.
// "Fix the typo in Button.tsx" and "implement a command palette" are both
// action tasks, but almost nothing else about them should be judged the same
// way: how long they may explore, how many files must change before the work
// is plausibly done, and whether reading counts as progress all differ.
//
// So the controller classifies the request ONCE, deterministically, into a
// shape, and every budget and completion rule below is derived from it.

export const TASK_SHAPES = [
  "question",         // explain / describe — must never be forced to mutate
  "single_file_fix",  // a narrow, scoped change to a named file
  "resume",           // pick up half-built work — expects fast mutation
  "test_only",        // the deliverable IS tests
  "refactor",         // restructuring / migration — wide but shallow
  "multi_file",       // a feature: several files, wiring, usually tests
];

// Picking up unfinished work. Deliberately checked before everything except
// the question guard: "finish the settings page" is a resume, not a feature
// request, and the difference is that the code already half exists — so there
// is far less to discover and mutation should come quickly.
const RESUME_RE = /\b(resume|continue|pick up (where|from)|carry on|finish(ing)?|complete|the rest of|remaining work|half[- ]?(built|finished|done|implemented)|partial(ly)?|already (started|begun|in progress)|unfinished)\b/i;

// Restructuring rather than adding. Touches many files but each change is
// mechanical, so it earns a long discovery budget and a slacker no-progress
// rule without earning a multi-file completion demand.
const REFACTOR_RE = /\b(refactor|restructure|reorganis[ez]|reorganiz|migrat(e|ion)|port|convert|modernis[ez]|moderniz|extract|deduplicate|consolidate|split (up|out)|tidy)\b/i;

// The request whose deliverable is tests. The optional filler words matter:
// "fix the failing tests" and "add some unit tests" must both match, because
// otherwise they fall through to multi_file and get held to a two-file demand
// that a test task has no reason to satisfy.
const TEST_OBJECT_RE = /\b(add|write|create|fix|update|improve|increase|extend|run|repair)\s+(the\s+|some\s+|more\s+|a\s+|few\s+|failing\s+|broken\s+|missing\s+|unit\s+|integration\s+|e2e\s+)*(tests?|specs?|test\s+suite|test\s+coverage|coverage)\b/i;

// Any mention of tests at all — used as a completion requirement, separately
// from the shape. "implement X and add tests" is a multi_file task that is
// not finished until a test file exists.
const MENTIONS_TESTS_RE = /\b(tests?|specs?|test\s+suite|coverage)\b/i;

// An explicit opt-out. Without this, merely naming tests in order to WAIVE
// them would create a requirement to write them.
const NO_TESTS_RE = /\b(no|without|skip(ping)?|don'?t (worry about|bother with|write|add)|not?\s+(writing|adding))\s+(any\s+|the\s+|new\s+)?tests?\b/i;

// The request explicitly asks for the thing to be CONNECTED, not merely
// written. This is the "created the component, never imported it" failure,
// and it is the one completion requirement a plan-less agent most often skips.
// `wire` on its own is a noun as often as a verb — "a wire protocol parser"
// is not a request to connect anything — so it must be followed by something
// that makes it an instruction.
const MENTIONS_INTEGRATION_RE = /\b(wire\s+(it|them|this|that|up|into|in\b)|wiring|hook (it |them )?up|integrat(e|ed|ing|ion)|end[- ]to[- ]end|end to end|so (it|the|they)\b[^.]{0,40}\b(open|opens|work|works|show|shows|appear|appears)|actually works?|usable|app integration|plumb)\b/i;

// A concrete file path in the request. The strongest available evidence that
// the user already knows the scope, which is what separates a single-file fix
// from an open-ended feature.
const NAMES_FILE_RE = /\b[\w.\-/]+\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|cpp?|h|css|s[ac]ss|html?|json|ya?ml|md|sql|sh|toml)\b/i;

/** Global twin of NAMES_FILE_RE — every path the request mentions, not just the first. */
const NAMES_FILE_RE_G = new RegExp(NAMES_FILE_RE.source, "gi");

/**
 * Every file path named in the request, as basenames.
 *
 * Basenames rather than full paths because the request and the workspace often
 * disagree about the prefix ("finish src/components/Palette.tsx" vs an edit
 * recorded as "components/Palette.tsx"), and a prefix mismatch must not be
 * mistaken for unfinished work.
 */
export function namedFiles(task) {
  const out = new Set();
  for (const m of String(task || "").match(NAMES_FILE_RE_G) ?? []) {
    const base = m.split("/").pop();
    if (base) out.add(base.toLowerCase());
  }
  return [...out];
}

// Repairing what already exists. A narrower act than building something new,
// so it gets the narrow shape unless the request says otherwise.
const FIX_VERB_RE = /\b(fix|repair|correct|resolve|debug|unbreak)\b/i;

// Phrases that describe an inherently tiny change.
const NARROW_FIX_RE = /\b(typo|one[- ]?liner?|single line|one line|off[- ]by[- ]one|missing (semicolon|import|comma|bracket|paren)|import statement|spelling)\b/i;

/** Is this path a test file? Used to check a "with tests" request was honoured. */
export function isTestPath(p) {
  const s = String(p || "");
  return /\.(test|spec)\.[\w]+$/i.test(s) || /(^|\/)(tests?|specs?|__tests__)(\/|$)/i.test(s);
}

/**
 * Classify the request into a shape, plus the standalone requirements it
 * implies. Pure and deterministic — the same string always yields the same
 * shape, so a misclassification is reproducible from the prompt alone.
 *
 * Order is the whole design here. The question guard wins outright; `resume`
 * and `refactor` beat `test_only` because "resume the feature and add tests"
 * is resumption work; `single_file_fix` is claimed only on positive evidence
 * of narrow scope, and everything left over defaults to `multi_file` — the
 * conservative choice, since assuming a task is bigger than it looks costs a
 * few turns, while assuming it is smaller ends the run half-done.
 */
export function classifyTask(task) {
  const m = String(task || "");
  const requiresMutation = detectActionIntent(m);
  // "…and don't bother with tests" must not be read as "…with tests".
  const mentionsTests = MENTIONS_TESTS_RE.test(m) && !NO_TESTS_RE.test(m);
  const mentionsIntegration = MENTIONS_INTEGRATION_RE.test(m);

  if (!requiresMutation) {
    return { shape: "question", requiresMutation: false, mentionsTests, mentionsIntegration, multiPart: false, named: [] };
  }

  // Positive evidence that the request spans more than one file, kept separate
  // from the shape: an unclassifiable request defaults to `multi_file` because
  // unknown scope deserves a long leash, but that is an ADMISSION OF IGNORANCE
  // and must not also be used to accuse the agent of under-delivering.
  const multiPart = looksMultiStep(m);
  const base = { requiresMutation: true, mentionsTests, mentionsIntegration, multiPart, named: namedFiles(m) };

  if (RESUME_RE.test(m)) return { shape: "resume", ...base };
  if (REFACTOR_RE.test(m)) return { shape: "refactor", ...base };

  // Tests are the deliverable only if nothing ELSE is being asked for. Strip
  // the test clause and see whether an instruction remains: "implement a
  // palette and add tests" still reads as an instruction, so it is not a
  // test-only task.
  if (TEST_OBJECT_RE.test(m) && !ACTION_VERB_RE.test(m.replace(TEST_OBJECT_RE, " "))) {
    return { shape: "test_only", ...base };
  }

  // Explicit multi-part phrasing, or an enumerated list, settles it.
  if (multiPart) return { shape: "multi_file", ...base };

  // Narrow when the user showed us the scope, or when the verb itself is
  // narrow: repairing something that already exists is a smaller act than
  // building something that does not, and "fix the date parser" should not be
  // held to the same breadth expectations as "build a dashboard".
  if (NAMES_FILE_RE.test(m) || NARROW_FIX_RE.test(m) || FIX_VERB_RE.test(m)) {
    return { shape: "single_file_fix", ...base };
  }

  return { shape: "multi_file", ...base };
}

/**
 * The execution budget for a shape.
 *
 * Flat thresholds punished the two ends of the distribution at once: ten turns
 * of discovery is absurd for a typo and stingy for a feature nobody has
 * mapped yet. These numbers stay conservative — the point is that they DIFFER
 * by shape, not that any one of them is aggressive.
 *
 *   maxDiscoveryTurns  reading before the agent is told to commit
 *   maxIterations      hard ceiling on tool-executing turns
 *   maxNoProgress      consecutive dead turns tolerated
 *   minMutatedFiles    files that must change before completion is plausible
 */
export function budgetFor(shape) {
  switch (shape) {
    // A question is never forced to mutate, so it gets room to read — that IS
    // the work — but not unbounded room.
    case "question":        return { maxDiscoveryTurns: 12, maxIterations: 40, maxNoProgress: 3, minMutatedFiles: 0 };
    // The scope is known. Reading past this point is avoidance.
    case "single_file_fix": return { maxDiscoveryTurns: 8,  maxIterations: 24, maxNoProgress: 3, minMutatedFiles: 1 };
    // The code already exists; the agent is orienting, not designing. Shortest
    // discovery of any action shape, because the failure mode here is reading
    // the half-built feature over and over instead of finishing it.
    case "resume":          return { maxDiscoveryTurns: 6,  maxIterations: 32, maxNoProgress: 3, minMutatedFiles: 1 };
    case "test_only":       return { maxDiscoveryTurns: 10, maxIterations: 30, maxNoProgress: 3, minMutatedFiles: 1 };
    // Wide but mechanical: many files, each change obvious once the pattern is
    // found, so tolerate a slower crawl without demanding two files.
    case "refactor":        return { maxDiscoveryTurns: 12, maxIterations: 40, maxNoProgress: 3, minMutatedFiles: 1 };
    // A feature nobody has mapped. Longest leash, and the only shape where one
    // changed file is treated as suspicious on its own.
    default:                return { maxDiscoveryTurns: 12, maxIterations: 40, maxNoProgress: 3, minMutatedFiles: 2 };
  }
}

/**
 * The concrete alternative to a tool path that keeps failing.
 *
 * "Try a different approach" is advice an agent satisfies by rephrasing the
 * same call. Naming the replacement TOOL is what actually moves it: an agent
 * guessing paths with read_file needs to be told to glob, not told to think
 * harder.
 */
export function alternativeStrategy(tool, reason = "") {
  const why = String(reason || "").toLowerCase();
  const missingPath = /enoent|no such file|not found|cannot find|does not exist/.test(why);
  const denied = /eacces|eperm|permission denied|read[- ]only/.test(why);
  const noMatch = /no match|no results|nothing found|0 matches/.test(why);
  const noCommand = /command not found|is not recognized|executable file not found|: not found/.test(why);

  if (noCommand) {
    return "That command does not exist in this environment. Read the project's manifest (package.json scripts, Makefile, pyproject.toml) and run the command the project actually defines — or report the missing tool as a blocker instead of guessing another invocation.";
  }
  if (denied) {
    return "The write was refused, and retrying it will be refused again. Write to a location you can actually modify, or stop and report the permission problem — do not reword the same write.";
  }
  switch (tool) {
    case "read_file":
      return missingPath
        ? "Stop guessing paths. Use `glob` with a name pattern (e.g. `**/*Palette*`) or `grep` for a symbol you know the file contains, then read the path it returns."
        : "Reading that path is not working. Locate the file with `glob` or `grep` and read what the search actually returns.";
    case "glob":
    case "grep":
    case "list_files":
      return noMatch
        ? "That search found nothing, so the name or pattern is wrong. Widen it: search a parent directory, drop the extension filter, or grep for a different symbol that must exist if the feature does."
        : "That search is not producing what you need. Change the pattern or the directory rather than re-running it — or `list_files` the parent directory to see what is really there.";
    case "edit_file":
      return "`edit_file` keeps failing, which usually means the text you are matching is not what the file contains. Re-read the exact region, then either edit against the real text or rewrite the whole unit with `write_file`. Do not retry the same match.";
    case "write_file":
      return "That write is not landing. Check the parent directory exists (create it with bash `mkdir -p`), or apply the change with `apply_patch` instead.";
    case "apply_patch":
      return "The patch does not apply, which means it was built against stale content. Re-read the file and make the change directly with `edit_file` or `write_file`.";
    case "bash":
      return "That command keeps failing. Run it a different way, check the working directory and the project's own scripts, or report it as a blocker — do not re-issue it unchanged.";
    default:
      return "This approach has failed repeatedly. Change the tool or the target rather than retrying the same call.";
  }
}

/**
 * Does this request obviously involve more than one step?
 *
 * Used for ONE bounded nudge: a feature-shaped request that produced a single
 * edit and no plan is the "wired up App.tsx, never wrote the component"
 * failure. The plan-based completion gate cannot catch it, because the agent
 * that skips planning also skips the evidence of what it left undone.
 *
 * Kept narrow — an explicit conjunction, an enumerated list, or the words that
 * name a multi-part deliverable. A false positive costs one extra turn asking
 * "is that everything?", which is why it is allowed to be imperfect; it is not
 * allowed to be broad.
 */
export function looksMultiStep(task) {
  // Strip an explicit test WAIVER first. Otherwise "add a toggle, no tests
  // needed" matches on the bare word `tests` and is read as a multi-part
  // request — the exact opposite of what it says.
  const m = String(task || "").replace(NO_TESTS_RE, " ");
  if (!m.trim()) return false;
  return (
    /\b(and then|then also|as well as|along with)\b/i.test(m) ||
    /\b(tests?|test suite|wiring|wire it up|integration|end to end|end-to-end)\b/i.test(m) ||
    /\b(each|every|all (of )?the)\b.*\b(file|component|route|endpoint|page)s\b/i.test(m) ||
    /^\s*\d+[.)]\s/m.test(m) ||                      // an enumerated list
    /\b(implement|build|create|add)\b.*\b(feature|system|palette|dashboard|flow|pipeline|page)\b/i.test(m)
  );
}

// Reading tools whose no-argument form is still a real question.
const TARGETLESS_INSPECTING_TOOLS = new Set(["list_memory_topics", "list_files", "review_patch"]);

/**
 * What a single inspection actually learned, as a comparable key.
 *
 * The naive key — just the path — treats a second look at a file as worthless,
 * which is wrong twice over: paging through a long file with `offset` reveals
 * genuinely new content each time, and the same grep pattern scoped to a
 * different directory is a different question. Both are ordinary reading
 * behaviour, and both looked like spinning under the old key.
 *
 * The key stays coarse enough that re-issuing the IDENTICAL call still
 * registers as nothing new — which is the case that must be caught.
 */
export function inspectionKey(tool, args = {}) {
  // `dir` matters as much as `path`: it is the ONLY argument `list_files`
  // takes, so without it every directory listing produced a null key and
  // earned nothing at all — while being one of the first things any agent does.
  const target = args.path ?? args.pattern ?? args.query ?? args.glob
    ?? args.dir ?? args.uri ?? args.topic ?? args.name ?? args.task_id;
  // For a few tools an absent target is a legitimate call — list the memory
  // topics, list the repository root, list the pending patches — so the tool
  // name alone is the key. The first call learns something and a Set makes
  // every repeat worth nothing, which is exactly right. Everywhere else a
  // missing target means a malformed call, not an inspection.
  if (target == null || target === "") {
    return TARGETLESS_INSPECTING_TOOLS.has(tool) ? `${tool}:*` : null;
  }
  // Distinguishing detail: which slice of the file, or which subtree was searched.
  const scope = [args.offset, args.limit, args.dir, args.path && args.pattern ? args.path : null]
    .filter((v) => v != null && v !== "")
    .join(":");
  return scope ? `${tool}:${target}#${scope}` : `${tool}:${target}`;
}

// After this many same-class attempts with no progress, the path is stuck.
const THRASH_THRESHOLD = 3;
// Bounded escalation. Beyond the last strategy there is nothing further to
// try, so the controller stops intervening rather than nagging forever.
const MAX_STRATEGY = 3;
// The verification gate may push back only this many times. Without a bound,
// a repo with no runnable check could never finish.
const MAX_VERIFY_PUSHBACKS = 2;
// Times the agent may be pushed back into execution before the refusal itself
// becomes the finding. Bounded for the same reason as the verify gate: a model
// that will not call a tool must not spin here forever.
const MAX_MUTATION_PUSHBACKS = 3;

// ── Execution budget ────────────────────────────────────────────────────────
// A stuck agent is indistinguishable from a working one if you only look at
// one turn, so every limit below is expressed over a WINDOW of turns. These
// are the numbers that stop a task from burning an entire quota on a wall it
// is never going to get through.
//
// The three limits that depend on how big the task is — the iteration ceiling,
// the dead-turn tolerance and the discovery budget — live in `budgetFor`,
// because a typo and an unmapped feature have no business sharing them. The
// ones below are about the SHAPE of a failure rather than the size of a task,
// so they are the same everywhere.
//
// How many times the SAME diagnostic may be hit before it counts as a hard
// blocker rather than a bug being worked through.
const MAX_SAME_ERROR_RETRIES = 4;
// How many writes one file may absorb without any progress anywhere. Four is
// enough to cover a legitimate write-check-adjust-recheck cycle, and short
// enough that a genuine edit loop is named as thrashing rather than falling
// through to the vaguer same-error rule.
const MAX_SAME_FILE_WRITES = 4;
// Forced re-plans allowed before thrashing is treated as terminal.
const MAX_REPLANS = 2;
// How many times the same action may fail the same way before the controller
// intervenes with a redirect. Two, because the first repeat is already the
// evidence: an action that failed identically twice will fail a third time.
const MAX_REPEATED_FAILURES = 2;
// How many times the same action may fail the same way before the run is
// stopped outright. Two turns past the redirect: the agent was told exactly
// what to try instead, and went back to the same wall anyway. Continuing past
// this is the "still exploring" fiction that burns a quota on a dead end.
const MAX_FAILURE_RETRIES = 4;
// Times the agent may be pushed back for an unfinished plan before the run is
// allowed to end anyway. Bounded like every other gate, so a plan whose items
// are never ticked off cannot trap the run.
const MAX_COMPLETION_PUSHBACKS = 2;

/** The four phases of a task. Derived from the state machine, not tracked separately. */
export const PHASES = ["DISCOVERY", "PLANNING", "IMPLEMENTATION", "VERIFICATION"];

export const STATES = ["inspect", "plan", "patch", "verify", "finish"];

/**
 * Every terminal outcome the controller can produce. The loop reports these
 * verbatim, so a caller can always tell a real success from an honest failure
 * — the distinction that "keep going until quota runs out" destroys.
 */
export const STOP_REASONS = {
  VERIFIED: "verified",                   // done, and the check passed
  BLOCKED: "blocked",                     // same error wall, repeatedly
  NO_PROGRESS: "no_progress",             // several turns changed nothing
  THRASHING: "thrashing",                 // re-planned, still going in circles
  BUDGET_EXHAUSTED: "budget_exhausted",   // ran out of turns
};

// Commands that constitute real verification. Mirrors the loop's own
// VERIFY_COMMAND_RE so both agree on what "verified" means.
// `check` and `verify` matter because plenty of projects name their gate that
// way — `npm run check`, `node --check file.mjs`, `yarn verify`. Without them
// a project whose only check is called `check` could never satisfy the finish
// gate, and the agent would be pushed to re-run something it had already run.
// `\bcheck\b` deliberately does NOT match `git checkout`.
export const VERIFY_COMMAND_RE =
  /\b(test|lint|tsc|typecheck|type-check|jest|vitest|pytest|eslint|ruff|mypy|build|check|verify|cargo\s+(check|test|build)|curl\s)\b/i;

// Compiler/type diagnostics. Used to tell "the same error keeps coming back"
// apart from "a different error each time" — the former is thrashing, the
// latter is progress.
const ERROR_CODE_RE = /\b(TS\d{4}|error TS\d+|Cannot find|Type '.*?' is not assignable|Property '.*?' does not exist|JSX element|Unexpected token|SyntaxError)\b/gi;

export function extractErrorSignature(text) {
  const matches = String(text || "").match(ERROR_CODE_RE);
  if (!matches) return null;
  // Sorted + deduped so the same diagnostics in a different order compare equal.
  return [...new Set(matches.map((m) => m.trim().toLowerCase()))].sort().join("|").slice(0, 200);
}

/**
 * The loop hands the controller `JSON.stringify(result)`, not raw stdout, so
 * the structured truth about what happened is right there — exit code,
 * timeout flag, the tool's own pass/fail. Reading it beats guessing from text.
 */
export function parsePayload(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

// A failure the TEXT can prove, used only when there is no exit code to trust.
// The count matters: "0 failed" and "1 failed" differ by one character and by
// everything else, so a bare /failed/ is worse than useless.
const COUNTED_FAILURE_RE = /\b[1-9]\d*\s+(?:\w+\s+)?(?:tests?|specs?|checks?|assertions?|examples?|problems?|errors?|failures?)?\s*(?:failed|failing|errors?|failures?)\b/i;
// Case matters here. Test runners shout `FAILED` in capitals when something
// broke, and print a lowercase "0 failed" when nothing did — so a
// case-insensitive match on the same word calls every green run a failure.
const SHOUTED_FAILURE_RE = /\b(FAILED|FAILURE|FAIL)\b/;
const HARD_FAILURE_RE = /\b(command not found|permission denied|ENOENT|EACCES|timed out|Segmentation fault|Traceback \(most recent call last\))\b/i;

/**
 * Did this verification actually pass?
 *
 * The previous rule was `!/\berror\b|\bfailed\b/` over the output — which
 * fails on the single most common line a passing test run prints. "26 passed,
 * 0 failed", "Found 0 errors", "test result: ok. 9 passed; 0 failed" were all
 * read as FAILURES, so a green suite could never satisfy the finish gate and
 * the agent got pushed back into re-running a check that had already passed.
 *
 * Ground truth is the exit code, and the loop already puts it in the payload.
 * Text is consulted only when there is no exit code to read.
 */
/**
 * A test command that ran nothing and exited 0.
 *
 * `node --test` in a project with no test files exits 0. So do jest, vitest and
 * pytest when nothing matches. The exit code says "passed" and the output says
 * "zero tests" — and the exit code used to win, so a run that verified nothing
 * was recorded as verified. That is not a hypothetical: an agent that could not
 * run the project's real (missing) test runner reached for `node --test`
 * instead, got a clean exit, and finished believing the suite was green.
 *
 * A check that could not have failed is not evidence, so it must not be
 * credited as verification.
 */
const VACUOUS_TEST_RUN_RE =
  /^\s*#\s*tests\s+0\s*$|^\s*#\s*pass\s+0\s*$|\bno tests? (?:were )?(?:found|ran|to run|matched)\b|\bno test (?:files?|suites?) found\b|\bfound no tests\b|\b0 (?:tests?|specs?|examples?) (?:ran|executed|passed)\b/im;

/**
 * Accepts either raw command output or a JSON tool payload. Both reach this
 * function in practice, and a JSON payload has its newlines escaped — so
 * testing the raw string would silently never match node's line-anchored TAP
 * summary. Parse first, then test.
 */
export function isVacuousTestRun(output) {
  const p = parsePayload(output);
  const s = p
    ? [p.stdout, p.stderr, p.output].filter(Boolean).join("\n")
    : String(output || "");
  // "# tests 0" must not match "# tests 10" — the multiline anchors above
  // handle node's TAP summary; the phrase alternatives cover the other runners.
  return VACUOUS_TEST_RUN_RE.test(s);
}

export function verificationOutcome(ok, output) {
  const p = parsePayload(output);
  if (p) {
    if (p.timed_out === true) return { passed: false, why: "timed out" };
    // Checked BEFORE exit_code: a vacuous test run's whole problem is that it
    // exits 0 while proving nothing.
    if (isVacuousTestRun(output)) return { passed: false, why: "the test command ran zero tests" };
    // `exit_code` is the authority. A process that exited 0 passed, whatever
    // words it printed on the way.
    if (typeof p.exit_code === "number") return { passed: p.exit_code === 0 };
    if (p.success === false) return { passed: false };
    // Tools that report their own verdict (verify_ui, hook results).
    if (typeof p.passed === "boolean") return { passed: p.passed };
    const text = [p.stdout, p.stderr, p.output, p.error].filter(Boolean).join("\n");
    if (text) return { passed: ok && !textShowsFailure(text) };
    if (p.success === true) return { passed: true };
  }
  if (!ok) return { passed: false };
  const raw = String(output || "");
  if (isVacuousTestRun(raw)) return { passed: false, why: "the test command ran zero tests" };
  return { passed: !textShowsFailure(raw) };
}

function textShowsFailure(text) {
  return Boolean(extractErrorSignature(text)) || COUNTED_FAILURE_RE.test(text)
    || HARD_FAILURE_RE.test(text) || SHOUTED_FAILURE_RE.test(text);
}

/**
 * A comparable signature for ANY failure, not just a compiler diagnostic.
 *
 * `extractErrorSignature` only recognises type/syntax errors, so the failures
 * that most deserve an early stop — a missing binary, a permission denial, a
 * module that will not resolve — produced no signature at all and could repeat
 * forever without ever counting as "the same wall twice". That is how a genuine
 * blocker ended up being reported as the vague `no_progress`.
 *
 * Volatile details (paths, line numbers, pids, hex, timings) are stripped so
 * the same failure from two different invocations compares equal.
 */
export function failureSignature(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^\s*at\s/.test(l));   // skip stack frames
  if (!line) return null;
  return line
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/['"`][^'"`]*['"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || null;
}

/**
 * What went wrong, in a form a human can act on. Kept separate from the
 * signature: the signature is for comparing, this is for reporting, and
 * flattening one into the other loses the detail that makes a blocker useful.
 */
export function failureReason(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l && !/^\s*at\s/.test(l));
  return (line || raw).slice(0, 200);
}

/**
 * A cheap, stable content fingerprint. Not cryptographic and does not need to
 * be — it answers "is this the same bytes I already saw", and a collision
 * costs one skipped re-read of a file whose content changed to something that
 * hashes identically. `crypto` is a core module, so this adds no dependency.
 */
export function hashContent(text) {
  return createHash("sha1").update(String(text ?? "")).digest("hex");
}

/** The repetition unit: which tool touched which file. */
export function fixSignature(tool, args) {
  const target = args?.path || args?.command || "";
  return `${tool}:${String(target).slice(0, 200)}`;
}

export function createTaskController({
  task = "",
  maxStrategy = MAX_STRATEGY,
  maxIterations,
  maxNoProgress,
  maxSameErrorRetries = MAX_SAME_ERROR_RETRIES,
  maxSameFileWrites = MAX_SAME_FILE_WRITES,
  maxReplans = MAX_REPLANS,
  maxDiscoveryTurns,
  maxRepeatedFailures = MAX_REPEATED_FAILURES,
  maxFailureRetries = MAX_FAILURE_RETRIES,
  maxCompletionPushbacks = MAX_COMPLETION_PUSHBACKS,
  minMutatedFiles,
} = {}) {
  // The shape decides the budgets. An explicit argument always wins, so a
  // caller (or a test) can still pin any threshold; omitted ones follow the
  // task rather than a global constant.
  const intent = classifyTask(task);
  const budget = budgetFor(intent.shape);
  maxIterations ??= budget.maxIterations;
  maxNoProgress ??= budget.maxNoProgress;
  maxDiscoveryTurns ??= budget.maxDiscoveryTurns;
  // The breadth demand needs evidence, not just an unclassifiable request.
  minMutatedFiles ??= intent.multiPart ? budget.minMutatedFiles : Math.min(budget.minMutatedFiles, 1);
  const history = [];          // every recorded tool call
  const verifications = [];    // verification attempts and outcomes
  const thrashEvents = [];     // detected stuck-path events

  let state = "inspect";
  let strategy = 1;            // escalates on each detected thrash
  let verifyPushbacks = 0;
  let lastErrorSignature = null;

  const editedPaths = new Set();
  const inspectedPaths = new Set();       // files actually read/searched
  const errorAttempts = new Map();        // error signature → times hit
  const writeAttempts = new Map();        // path → writes absorbed

  let iterations = 0;
  let noProgressStreak = 0;
  let replans = 0;
  let stopReason = null;
  let stopDetail = "";

  let lastPlanShape = null;   // dedupes re-submitted todo lists
  let planRevisions = 0;      // genuinely new plans written
  let openTodos = [];         // plan items not yet marked completed
  let planItemCount = 0;      // size of the most recent plan
  let completionPushbacks = 0;
  let incompleteOnFinish = false;  // finished with plan items still open
  let settledGate = null;          // the terminal verdict, once reached
  let shapeChallenged = false;     // the one-time "does this look done?" challenge
  let unmetOnFinish = [];          // shape requirements never satisfied
  let markersChallenged = false;   // the one-time "you left the TODOs" challenge (resume only)
  let markersOnFinish = [];        // unfinished-work markers still present at the end

  // ── Recovery memory ───────────────────────────────────────────────────────
  // What has already been TRIED AND FAILED in this task, keyed by the action
  // (tool + file or command) and the way it failed. Without this the agent has
  // no memory of dead ends: it re-runs the command that is not installed, or
  // re-writes the file it has no permission for, and each attempt looks new.
  const failureMemory = new Map();   // "tool:target|signature" → { tool, target, reason, count }
  const failuresWarned = new Set();  // keys already redirected, so we nag once
  // Actions that failed at least once, keyed WITHOUT the failure mode. When one
  // of these later succeeds, a concrete blocker was cleared — which is real
  // semantic progress and nothing else in the counters would notice it.
  const failedActions = new Set();   // "tool:target"
  let resolvedBlockers = 0;

  // ── Task memory ───────────────────────────────────────────────────────────
  // What this task has learned, for the lifetime of this task and no longer.
  // It is deliberately part of the controller rather than a store of its own:
  // the controller already sees every executed call at a single choke point,
  // already lives exactly as long as one task, and already holds the failure
  // half of this. A second memory alongside it would be two things to keep in
  // sync and two places to be wrong.
  //
  //   explored  — files actually opened, and when
  //   failed    — approaches that did not work (failureMemory, above)
  //   fixed     — approaches that DID work, which nothing recorded before
  const explored = new Map();        // path → { firstAt, lastAt, reads }
  const successfulFixes = [];        // { tool, target, at, after }
  let discoveryTurns = 0;     // turns spent reading before any real work
  let discoveryCapped = false;
  let discoveryGraceUsed = false;  // the one-time reprieve in the first pass

  // Whether this task obliges the agent to change the workspace. Computed once
  // from the request, deterministically — never re-derived from the model's
  // own account of what it is doing.
  const requiresMutation = intent.requiresMutation;
  let mutations = 0;          // real workspace changes, by any means
  let pathlessMutations = 0;  // bash / apply_patch — not attributable to a tracked path
  let mutationPushbacks = 0;
  // Changes to code that ALREADY EXISTED. The distinction matters for exactly
  // one question — "was the new thing ever connected to anything?" — because a
  // run that only creates files has, by definition, wired nothing up.
  let integrationEdits = 0;
  // History index of the most recent real change. A verification taken BEFORE
  // this is stale: it certifies a workspace that no longer exists.
  let lastMutationAt = -1;
  const mutatedPaths = new Set();  // every path changed, including via write_file

  // Snapshot of the counters as of the end of the previous iteration. Progress
  // is a DELTA against this, which is what makes "did this turn accomplish
  // anything" answerable at all.
  let mark = {
    inspected: 0, edited: 0, mutations: 0, pathlessMutations: 0, verifications: 0,
    planRevisions: 0, resolvedBlockers: 0, errorSignature: null, passed: false,
  };

  /** Advance only forwards; the machine never silently regresses. */
  function enter(next) {
    if (STATES.indexOf(next) > STATES.indexOf(state)) state = next;
  }

  function recordToolCall({ tool, args = {}, ok = true, output = "" } = {}) {
    const entry = {
      tool,
      signature: fixSignature(tool, args),
      ok,
      mutating: MUTATING_TOOLS.has(tool),
      errorSignature: ok ? null : extractErrorSignature(output),
      at: history.length,
    };
    history.push(entry);

    // Remember every failure, whatever the tool. Keyed by action AND failure
    // mode, so "the same edit failing the same way" is distinguishable from
    // "the same edit now failing differently" — the second is progress.
    const actionKey = `${tool}:${String(args?.path || args?.command || args?.pattern || "").slice(0, 120)}`;
    if (!ok) {
      const target = args?.path || args?.command || args?.pattern || "";
      const sig = failureSignature(output);
      const key = `${actionKey}|${sig || "unknown"}`;
      const prior = failureMemory.get(key);
      failureMemory.set(key, {
        tool,
        target: String(target).slice(0, 120),
        reason: failureReason(output),
        count: (prior?.count || 0) + 1,
      });
      entry.failureKey = key;
      failedActions.add(actionKey);
    } else if (failedActions.has(actionKey)) {
      // The wall came down. Getting a previously-failing action to work is the
      // clearest evidence that a recovery attempt paid off, and it is invisible
      // to every counter here — the file was already read, the edit already
      // attributed — so credit it explicitly.
      failedActions.delete(actionKey);
      resolvedBlockers++;
      entry.resolvedBlocker = true;
      // …and remember WHAT worked, not just that something did. "Reading it
      // first made the edit apply" is the single most reusable thing a task
      // learns, and until now it was thrown away the instant it happened.
      const priorFailure = [...failureMemory.values()].find(
        (f) => `${f.tool}:${f.target}` === actionKey,
      );
      successfulFixes.push({
        tool,
        target: String(args?.path || args?.command || args?.pattern || "").slice(0, 120),
        at: entry.at,
        after: priorFailure?.reason || "",
      });
    }

    // Files this task has actually opened. Tracked by real path (not the
    // coarser inspection key) because the question it answers is "have I
    // already got this?", which is about the file, not about the slice read.
    if (tool === "read_file" && args?.path) {
      const rec = explored.get(args.path);
      if (rec) { rec.lastAt = entry.at; rec.reads++; if (ok) rec.ok = true; }
      else explored.set(args.path, { firstAt: entry.at, lastAt: entry.at, reads: 1, ok });
    }

    if (entry.mutating) {
      if (args?.path) {
        // Editing something that was here before is integration; writing a
        // brand-new file is not. `edit_file` always modifies existing code;
        // a `write_file` counts too once the agent has read that path, which
        // is how it rewrites an existing module.
        // `write_file` reports `action: "create" | "edit"` — it stat'd the path,
        // so that is ground truth about whether the file already existed. Use
        // it in preference to inferring from what the agent happened to read:
        // a rename, a move or a cross-file rewrite is integration whether or
        // not this controller saw a read first.
        const reported = parsePayload(output)?.action;
        const modifiedExisting = reported
          ? reported !== "create"
          : tool === "edit_file" || inspectedPaths.has(inspectionKey("read_file", { path: args.path }));
        if (ok && modifiedExisting) integrationEdits++;
        editedPaths.add(args.path);
        if (ok) {
          mutatedPaths.add(args.path);
          // Only writes that LANDED count toward thrashing. A rejected write
          // never changed the file, so calling it a rewrite misdiagnoses a
          // permission or path problem as an editing loop — and buries the
          // one detail the user needs. Failed writes are handled by the
          // failure memory instead, which names the actual error.
          writeAttempts.set(args.path, (writeAttempts.get(args.path) || 0) + 1);
        }
      }
      if (ok) { mutations++; lastMutationAt = entry.at; }
      enter("patch");
    } else if (ok && PATCH_TOOLS.has(tool)) {
      // Changes the tree without carrying a `path` argument.
      mutations++; pathlessMutations++; lastMutationAt = entry.at;
      enter("patch");
    } else if (ok && tool === "review_patch") {
      // Only APPROVING applies a subagent's work. `diff` reads it and `reject`
      // throws it away — both leave the workspace exactly as it was.
      if (String(args?.action || "") === "approve") {
        mutations++; lastMutationAt = entry.at;
        // Applying a patch reports exactly which files it touched, and the loop
        // records every one of them as an edit. Using that list keeps the run
        // attributable: treating subagent work as an anonymous "something
        // changed" switched off every completion check, so the largest changes
        // in the system were the least scrutinised.
        const files = parsePayload(output)?.files;
        if (Array.isArray(files) && files.length) {
          for (const f of files) {
            const rel = String(f);
            editedPaths.add(rel);
            mutatedPaths.add(rel);
            integrationEdits++;   // the loop records applied patch files as edits
          }
        } else {
          pathlessMutations++;    // no file list — genuinely unattributable
        }
        enter("patch");
      } else {
        const key = inspectionKey(tool, args);
        if (key) inspectedPaths.add(`${key}:${args?.action || "list"}`);
      }
    } else if (ok && tool === "bash" && isMutatingCommand(String(args?.command || ""))) {
      mutations++; pathlessMutations++; lastMutationAt = entry.at;
      enter("patch");
    } else if (tool === "todo_write") {
      // A plan only counts once. Re-submitting the same todo list is the
      // planning equivalent of re-reading a file you have already read.
      const shape = JSON.stringify(args?.todos ?? args ?? "").slice(0, 2000);
      if (shape !== lastPlanShape) {
        lastPlanShape = shape;
        planRevisions++;
      }
      // The plan doubles as the definition of done. Items the agent has not
      // ticked off are the deterministic answer to "is this task finished?",
      // which otherwise only the model's own optimism could decide.
      const todos = Array.isArray(args?.todos) ? args.todos : [];
      if (todos.length) {
        planItemCount = todos.length;
        openTodos = todos
          .filter((t) => t?.status !== "completed")
          .map((t) => String(t?.content ?? "").slice(0, 120))
          .filter(Boolean);
      }
      enter("plan");
    } else if (INSPECTING_TOOLS.has(tool)) {
      // Registered whether or not the call SUCCEEDED. A read that returns
      // ENOENT still narrows the search — "the file is not there" is exactly
      // how an agent locates an unfamiliar layout. Requiring `ok` meant an
      // agent probing four plausible paths for a component scored four dead
      // turns and was stopped before it had read anything at all.
      const key = inspectionKey(tool, args);
      if (key) inspectedPaths.add(key);
    } else if (ok && tool === "bash") {
      // A shell command that neither changes files nor verifies is how agents
      // actually explore — `ls`, `cat`, `git log`, `find`. Left unclassified,
      // a turn spent this way counted as nothing and pushed the agent toward
      // a no-progress stop while it was doing ordinary reconnaissance.
      // Keyed on the command, so re-issuing the identical one still earns
      // nothing. Verify commands are handled separately below.
      const cmd = String(args?.command || "");
      if (cmd && !VERIFY_COMMAND_RE.test(cmd)) inspectedPaths.add(`bash:${cmd.slice(0, 200)}`);
    }

    // A verification command is what moves the machine into `verify` — and so
    // does `verify_ui`, which drives a real browser against a running app. It
    // is the strongest check the agent has, and the gate used to ignore it
    // entirely: an agent that proved the feature works in a browser was still
    // told "you have not verified your changes".
    const isVerifyBash = tool === "bash" && VERIFY_COMMAND_RE.test(String(args?.command || ""));
    if (isVerifyBash || tool === "verify_ui") {
      const { passed } = verificationOutcome(ok, output);
      const command = isVerifyBash ? String(args.command) : `verify_ui ${args?.url || ""}`.trim();
      verifications.push({ command, passed, at: history.length });
      // Fall back to the general signature when there is no compiler
      // diagnostic: "vitest: command not found" is a wall worth naming, and
      // without this it registered as nothing at all.
      const sig = passed ? null : (extractErrorSignature(output) || failureSignature(output));
      // Track whether the SAME diagnostics keep reappearing.
      entry.errorSignature = sig;
      lastErrorSignature = sig;
      if (!passed && sig) errorAttempts.set(sig, (errorAttempts.get(sig) || 0) + 1);
      enter("verify");
    }
    return entry;
  }

  /**
   * "Have I already done this, and is the answer still good?"
   *
   * The duplicate-work case that actually costs something is re-reading a file
   * this task has already read and has not changed since. The content is
   * identical, so the second read buys nothing and spends a turn plus the
   * whole file in context — and an agent with no memory of having read it has
   * no reason not to do exactly that.
   *
   * Returns null unless the call is provably redundant. Deliberately
   * conservative: if the file was written to since the last read, or the read
   * asked for a different slice, this says nothing — a stale hint is worse
   * than no hint, because acting on it would mean editing against content
   * that has changed.
   */
  /**
   * Has this exact file content already been delivered to the model?
   *
   * Called with the content the read JUST returned, so this never assumes the
   * file is unchanged — it PROVES it, by comparing what is on disk now with
   * what was handed over before. That distinction matters: a user editing a
   * file in their own editor mid-run is ordinary, and an optimisation that
   * assumed otherwise would quietly feed the model stale code.
   *
   * When it matches, the caller can replace a few thousand duplicate tokens
   * with one line — the work is genuinely avoided, not merely flagged.
   */
  function recallRead(path, content) {
    if (!path || typeof content !== "string") return null;
    const rec = explored.get(path);
    if (!rec?.hash) return null;
    const hash = hashContent(content);
    if (hash !== rec.hash) { rec.hash = hash; return null; }   // it changed — remember the new state
    return { duplicate: true, at: rec.lastAt, reads: rec.reads };
  }

  /** Remember what a successful read actually returned, for `recallRead`. */
  function rememberRead(path, content) {
    const rec = explored.get(path);
    if (rec && typeof content === "string") rec.hash = hashContent(content);
  }

  function recall(tool, args = {}) {
    if (tool !== "read_file") return null;
    const p = args?.path;
    if (!p) return null;
    const rec = explored.get(p);
    if (!rec || !rec.ok) return null;
    // A different window of the file is a different question.
    if (args.offset != null || args.limit != null) return null;
    // Anything that changed the file invalidates what we remember about it.
    const changedSince = history.some(
      (h) => h.at > rec.lastAt && h.mutating && h.ok !== false && h.signature.endsWith(`:${p}`),
    );
    if (changedSince) return null;
    return { path: p, at: rec.lastAt, reads: rec.reads };
  }

  /** Explicit hook for verification run outside the bash tool (e.g. a stop hook). */
  function recordVerification({ command = "(stop hook)", passed, output = "" } = {}) {
    // A caller's `passed` is usually just an exit code, and an exit code cannot
    // see that the suite ran zero tests. Both routes into the controller must
    // agree on what "verified" means, or the same command certifies the
    // workspace through one path and not the other.
    if (passed && isVacuousTestRun(output)) passed = false;
    verifications.push({ command, passed: !!passed, at: history.length });
    if (!passed) {
      const sig = extractErrorSignature(output);
      lastErrorSignature = sig ?? lastErrorSignature;
      if (sig) errorAttempts.set(sig, (errorAttempts.get(sig) || 0) + 1);
    }
    enter("verify");
  }

  /**
   * Did this turn accomplish anything? Answered as a delta against the last
   * turn, because the useful question is never "did work happen" (the model
   * always emits tool calls) but "did the situation change".
   *
   * WHAT COUNTS DEPENDS ON THE PHASE. This is the crux: a turn spent only
   * reading files is exactly right during discovery and exactly wrong once the
   * agent is supposed to be editing. Judging both by a single rule either
   * cuts off legitimate exploration or lets a stuck implementation spin.
   *
   *   DISCOVERY      reading anything new — that IS the work
   *   PLANNING       a genuinely revised plan, or new information
   *   IMPLEMENTATION a successful mutation (reading still counts; you often
   *                  need to re-read a file to edit it correctly)
   *   VERIFICATION   a check that ran, or diagnostics that moved
   *
   * Signals from a LATER phase always count, in every phase — starting to edit
   * during discovery is unambiguous progress.
   *
   * Deliberately NOT progress in any phase: re-issuing an identical read, or
   * re-editing a file while the same diagnostic persists. Those are the
   * runaway patterns this exists to catch.
   */
  function assessProgress() {
    const passed = verificationPassed();
    const reasons = [];

    const learnedSomething = inspectedPaths.size > mark.inspected;
    const editedSomethingNew = editedPaths.size > mark.edited;
    // Only mutations that DIDN'T go through a tracked path — a bash command or
    // an apply_patch. A repeat write to a file already edited must not count:
    // that is precisely the thrash pattern, and crediting it would make the
    // no-progress streak unreachable.
    const changedByOtherMeans = pathlessMutations > mark.pathlessMutations;
    // Likewise, only the FIRST check earns credit. Re-running the same failing
    // typecheck forever is not progress; a changed diagnostic is, and is
    // credited separately below.
    const firstVerification = verifications.length > mark.verifications && mark.verifications === 0;
    const diagnosticsMoved = lastErrorSignature !== mark.errorSignature;
    const planAdvanced = planRevisions > mark.planRevisions;
    const unblocked = resolvedBlockers > mark.resolvedBlockers;

    // Phase-independent: any real forward motion counts everywhere.
    if (editedSomethingNew) reasons.push("edited a new file");
    if (changedByOtherMeans) reasons.push("changed the workspace");
    if (firstVerification) reasons.push("ran verification");
    if (diagnosticsMoved) reasons.push("diagnostics changed");
    if (passed && !mark.passed) reasons.push("verification now passes");
    // Semantic, not numeric: something that was failing now works.
    if (unblocked) reasons.push("cleared a blocker");

    // Phase-dependent: whether reading and planning are the job right now.
    const phase = currentPhase();
    if (intent.shape === "question") {
      // A question has no implementation phase to move on to, so reading is
      // the work from start to finish. Holding it to the implementation rule
      // would starve exactly the task that is behaving correctly — and the
      // discovery budget still bounds it.
      if (learnedSomething && !discoveryCapped) reasons.push("inspected new files");
      if (planAdvanced) reasons.push("wrote a plan");
    } else if (phase === "DISCOVERY") {
      // Exploration IS the work — until the discovery budget says otherwise,
      // at which point reading alone stops earning credit and the agent has
      // to convert what it has learned into a plan or an edit.
      if (learnedSomething && !discoveryCapped) reasons.push("inspected new files");
      if (planAdvanced) reasons.push("wrote a plan");
    } else if (phase === "PLANNING") {
      if (planAdvanced) reasons.push("revised the plan");
      if (learnedSomething) reasons.push("gathered new information");
    } else {
      // IMPLEMENTATION / VERIFICATION: reading is still legitimate support
      // work — you re-read a file to edit it correctly — but on its own it no
      // longer justifies a turn indefinitely, so it is credited only while
      // something is actually being changed or checked.
      if (learnedSomething) reasons.push("inspected new files");
    }

    return { progressed: reasons.length > 0, reasons, phase };
  }

  /**
   * The phase, derived from the state machine rather than tracked separately —
   * one source of truth for "where is this task". `inspect`/`plan`/`patch`/
   * `verify` already advance monotonically on real events.
   */
  function currentPhase() {
    switch (state) {
      case "inspect": return "DISCOVERY";
      case "plan":    return "PLANNING";
      case "patch":   return "IMPLEMENTATION";
      default:        return "VERIFICATION";
    }
  }

  /**
   * An action that has now failed the same way more than once, and has not
   * already been flagged. Returns null when there is nothing new to say — the
   * agent is warned once per dead end, not on every subsequent turn.
   */
  function repeatedFailure() {
    for (const [key, rec] of failureMemory) {
      if (rec.count >= maxRepeatedFailures && !failuresWarned.has(key)) {
        return { key, ...rec };
      }
    }
    return null;
  }

  /**
   * Push the agent onto a different path. Deliberately concrete about WHAT
   * failed and HOW, because "try something else" without naming the dead end
   * tends to produce a cosmetic variation of the same attempt.
   */
  function recoveryDirective(rec) {
    const what = rec.target ? `\`${rec.tool}\` on \`${rec.target}\`` : `\`${rec.tool}\``;
    return [
      `STOP — ${what} has now failed ${rec.count} times with the same error:`,
      `    ${rec.reason}`,
      "",
      // The named replacement, chosen from the tool and the failure mode. A
      // generic "try something else" gets answered with a reworded version of
      // the same call; naming the tool to switch to does not.
      `Do this instead: ${alternativeStrategy(rec.tool, rec.reason)}`,
      "",
      "Do not repeat the call that failed. If no alternative exists, say so plainly and stop.",
    ].join("\n");
  }

  /** An action the agent was already redirected away from and went back to anyway. */
  function ignoredRedirect() {
    for (const [key, rec] of failureMemory) {
      if (rec.count >= maxFailureRetries && failuresWarned.has(key)) return rec;
    }
    return null;
  }

  function stop(reason, detail) {
    stopReason = reason;
    stopDetail = detail;
    return { stop: true, reason, detail };
  }

  /**
   * Called once per tool-executing turn. This is the termination policy: the
   * single place that decides a task should end early, and the only source of
   * a structured stop reason.
   *
   * Returns { stop, reason, detail, progressed, iterations }. When `stop` is
   * true the loop must break and report `detail` as the real blocker — never
   * summarise it as success.
   */
  function endIteration() {
    iterations++;
    const phaseAtStart = currentPhase();
    if (phaseAtStart === "DISCOVERY") discoveryTurns++;

    const { progressed, reasons, phase } = assessProgress();

    if (progressed) noProgressStreak = 0;
    else noProgressStreak++;

    // Re-mark for the next delta.
    mark = {
      inspected: inspectedPaths.size,
      edited: editedPaths.size,
      mutations,
      pathlessMutations,
      verifications: verifications.length,
      planRevisions,
      resolvedBlockers,
      errorSignature: lastErrorSignature,
      passed: verificationPassed(),
    };

    const base = {
      stop: false, progressed, reasons, phase, iterations, noProgressStreak, discoveryTurns,
      shape: intent.shape,
    };

    // ── Recovery memory ────────────────────────────────────────────────────
    // Checked first: an agent walking back into a known dead end should be
    // redirected before any other advice, because every other directive
    // assumes the current approach can still work.
    const repeated = repeatedFailure();
    if (repeated) {
      failuresWarned.add(repeated.key);
      return {
        ...base,
        directiveKind: "recovery",
        directive: recoveryDirective(repeated),
        strategy: alternativeStrategy(repeated.tool, repeated.reason),
      };
    }

    // ── Discovery budget ───────────────────────────────────────────────────
    // Exploration is legitimate but not unlimited. Once the budget is spent,
    // reading stops counting as progress (see assessProgress), so an agent
    // that keeps browsing will now accumulate a no-progress streak and be
    // stopped by the normal rule. This is a directive, not a stop: the agent
    // is being told to move on, not that it has failed.
    if (phase === "DISCOVERY" && discoveryTurns >= maxDiscoveryTurns && !discoveryCapped) {
      discoveryCapped = true;
      return {
        ...base,
        directiveKind: "discovery_budget",
        directive: [
          `You have spent ${discoveryTurns} turns exploring the repository. That is enough reading.`,
          "",
          "Convert what you now know into action:",
          "1. State the concrete plan in one or two sentences — which files you will change and how.",
          "2. Then start making the edits with write_file / edit_file.",
          "If something is still genuinely unclear, call ask_user rather than continuing to browse.",
        ].join("\n"),
      };
    }

    // Hard ceiling first — nothing below matters if there are no turns left.
    if (iterations >= maxIterations) {
      return { ...base, ...stop(STOP_REASONS.BUDGET_EXHAUSTED,
        `Reached the ${maxIterations}-step limit for a single task.`) };
    }

    // One file absorbing writes while nothing improves. Checked BEFORE the
    // same-error rule because it is the more specific diagnosis: "you keep
    // rewriting this one file" tells the user more than "something failed
    // repeatedly", and both would otherwise fire on the same run.
    for (const [file, count] of writeAttempts) {
      if (count >= maxSameFileWrites && noProgressStreak > 0) {
        return { ...base, ...stop(STOP_REASONS.THRASHING,
          `Rewrote ${file} ${count} times without improving the result.`) };
      }
    }

    // The same wall, over and over. Distinct from thrashing: here the agent
    // may be varying its approach across different files and still be unable
    // to get past one error.
    for (const [sig, count] of errorAttempts) {
      if (count >= maxSameErrorRetries) {
        return { ...base, ...stop(STOP_REASONS.BLOCKED,
          `The same failure survived ${count} attempts: ${sig.slice(0, 200)}`) };
      }
    }

    // Redirected once, went back to the same wall regardless. There is nothing
    // left to suggest, so this is named as the blocker it is rather than left
    // to accumulate turns and surface later as a vague no_progress.
    //
    // Deliberately AFTER the thrash and same-error rules: both are more
    // specific diagnoses of the same run, and "you rewrote this file four
    // times" tells the user more than "an action kept failing".
    const ignored = ignoredRedirect();
    if (ignored) {
      return { ...base, ...stop(STOP_REASONS.BLOCKED,
        `\`${ignored.tool}\`${ignored.target ? ` on \`${ignored.target}\`` : ""} failed ${ignored.count} times with the same error and no alternative worked: ${ignored.reason}`) };
    }

    // Re-planning was already forced and it did not help.
    if (replans > maxReplans) {
      return { ...base, ...stop(STOP_REASONS.THRASHING,
        `Re-planned ${replans} times and kept repeating the same failing change.`) };
    }

    if (noProgressStreak >= maxNoProgress) {
      // ── The first-pass reprieve ────────────────────────────────────────────
      // A task must not die during its opening reconnaissance. An agent that
      // is still orienting — probing for a file, re-reading something it half
      // understands — looks identical to a stuck one for a few turns, and
      // killing it there is the difference between "resumed the half-built
      // feature" and "read some files, gave up".
      //
      // So the first time exploration stalls, the answer is a directive rather
      // than a stop: say what is missing and point at the exit. It is granted
      // ONCE, only during discovery, and it ends the discovery budget on the
      // spot — so reading immediately stops earning credit and a further
      // stall lands on the normal rule below. A genuine loop costs a few extra
      // turns to name; a recoverable one gets to recover.
      if (phase === "DISCOVERY" && !discoveryGraceUsed) {
        discoveryGraceUsed = true;
        discoveryCapped = true;
        noProgressStreak = 0;
        return {
          ...base,
          noProgressStreak: 0,
          directiveKind: "discovery_grace",
          directive: [
            "You are not learning anything new — the last few steps repeated work you had already done.",
            "",
            "Stop exploring and commit to an action:",
            requiresMutation
              ? "1. Decide the single most likely file to change and open it, or create the new file outright with write_file."
              : "1. Answer with what you already know, or open the one file that would settle the question.",
            "2. If you cannot find what you are looking for, search for it by name with glob or grep instead of guessing paths.",
            "3. If it genuinely is not there, say so plainly or call ask_user — do not keep re-reading the same things.",
          ].join("\n"),
        };
      }

      // Past the reprieve. For an action task that never touched the workspace,
      // name that specifically — "I explored and never changed anything" is a
      // far more useful blocker than "steps changed nothing".
      // Say what actually happened. "No new files" is plainly false for a
      // question that read twenty of them — the real finding is that it kept
      // reading instead of answering, and a report the user can recognise is
      // worth more than a uniform one.
      const detail = !requiresMutation
        ? `Looked at ${inspectedPaths.size} thing${inspectedPaths.size === 1 ? "" : "s"} over ${iterations} steps without producing an answer, and the last ${noProgressStreak} steps turned up nothing new.`
        : mutations === 0
          ? `Explored for ${iterations} steps without making any change to the workspace, and the last ${noProgressStreak} steps turned up nothing new.`
          : `${noProgressStreak} consecutive steps changed nothing — no new files, no new edits, no change in diagnostics.`;
      return { ...base, ...stop(STOP_REASONS.NO_PROGRESS, detail) };
    }

    return base;
  }

  /**
   * The honest report for an early stop. Says what was actually done and what
   * is actually blocking, so the caller never has to guess whether a short run
   * was a success or a wall.
   */
  function blockerReport() {
    if (!stopReason) return "";
    const lines = [
      `**Stopped early — \`${stopReason}\`.** I did not finish this task.`,
      "",
      stopDetail,
      "",
    ];
    if (editedPaths.size) lines.push(`Files changed so far: ${[...editedPaths].join(", ")}`);
    else lines.push("No files were changed.");

    // The dead ends, named. A blocker the user can act on ("vitest is not
    // installed") is worth more than the whole rest of this report.
    const dead = [...failureMemory.values()].filter((f) => f.count >= maxRepeatedFailures);
    if (dead.length) {
      lines.push("", "What repeatedly failed:");
      for (const f of dead.slice(0, 5)) {
        lines.push(`- \`${f.tool}\`${f.target ? ` on \`${f.target}\`` : ""} — ${f.reason} (×${f.count})`);
      }
    }

    // What DID work. On a stopped run this is the part worth keeping: it tells
    // the user (and the next attempt) which approaches were already proven.
    if (successfulFixes.length) {
      lines.push("", "What did work:");
      for (const f of successfulFixes.slice(0, 5)) {
        lines.push(`- \`${f.tool}\`${f.target ? ` on \`${f.target}\`` : ""} succeeded after${f.after ? `: ${f.after}` : " an earlier failure"}`);
      }
    }

    if (openTodos.length) {
      lines.push("", `Still open from the plan: ${openTodos.join("; ")}`);
    }

    // What the request asked for that never happened — independent of whether
    // the agent kept a plan, so this is still reported when it kept none.
    const unmet = unmetRequirements([...editedPaths]);
    if (unmet.length) {
      lines.push("", "What the request asked for and did not get:");
      for (const u of unmet) lines.push(`- ${u}`);
    }

    if (!verifications.length) lines.push("No verification was run, so nothing here is confirmed working.");
    else if (verificationStale()) lines.push(`The last check (\`${verifications[verifications.length - 1].command}\`) passed, but files changed afterwards — nothing has verified the current state.`);
    else if (!verificationPassed()) lines.push(`Verification ran and is still failing (\`${verifications[verifications.length - 1].command}\`).`);
    else lines.push("The last verification run did pass.");

    lines.push("", "I stopped rather than keep retrying the same approach. Tell me how you'd like to proceed, or give me the missing detail and I'll continue.");
    return lines.join("\n");
  }

  const verificationRan = () => verifications.length > 0;
  // "Did a check ever pass" — the right question for PROGRESS (a pass is real
  // forward motion even if later undone) and for thrash detection.
  const verificationPassed = () => verifications.some((v) => v.passed);

  /**
   * "Is the workspace AS IT STANDS verified" — the right question for the
   * finish gate, and a different question entirely.
   *
   * Two ways the old `some(v => v.passed)` lied. A check that passed and was
   * then superseded by a failing re-run still counted as verified. And a check
   * that passed before three more files were edited still counted as verified.
   * Both let the agent report success for a state nothing had ever checked.
   */
  function verificationCurrent() {
    const last = verifications[verifications.length - 1];
    if (!last) return false;
    return last.passed && last.at > lastMutationAt;
  }
  const verificationStale = () =>
    verifications.length > 0 &&
    verifications[verifications.length - 1].passed &&
    verifications[verifications.length - 1].at <= lastMutationAt;

  /**
   * "Progress" separates a retry from a loop. A same-class attempt counts as
   * progress if, since the first attempt of that class, either a verification
   * passed or the failing diagnostics actually changed. Editing the same file
   * three times while the identical type error persists is not progress.
   */
  function detectThrash() {
    const mutating = history.filter((h) => h.mutating);
    if (mutating.length < THRASH_THRESHOLD) return null;

    const counts = new Map();
    for (const h of mutating) counts.set(h.signature, (counts.get(h.signature) || 0) + 1);

    for (const [signature, count] of counts) {
      if (count < THRASH_THRESHOLD) continue;

      const first = mutating.find((h) => h.signature === signature).at;
      if (verifications.some((v) => v.at > first && v.passed)) continue; // the repetition was productive

      // Did the failure actually change between attempts? One distinct
      // signature (or none at all) means every retry hit the same wall.
      const distinctErrors = new Set(
        history.filter((h) => h.at > first && h.errorSignature).map((h) => h.errorSignature),
      );
      if (distinctErrors.size > 1) continue; // the error is moving — real progress

      // Report each (signature, count) pair once so a single stuck path does
      // not fire on every subsequent turn.
      if (thrashEvents.some((e) => e.signature === signature && e.count === count)) continue;
      const event = { signature, count, errorSignature: lastErrorSignature };
      thrashEvents.push(event);
      return event;
    }
    return null;
  }

  /**
   * Escalate to a structurally different approach. Repeating a failed edit
   * pattern with more determination does not help; changing the shape of the
   * attempt does.
   */
  function escalateStrategy() {
    replans++;
    strategy = Math.min(strategy + 1, maxStrategy + 1);
    return strategy;
  }

  function strategyDirective(event) {
    const target = event.signature.split(":").slice(1).join(":");
    const shared = [
      `You have edited \`${target}\` ${event.count} times without the check passing.`,
      event.errorSignature ? `The same failure keeps returning: ${event.errorSignature.slice(0, 160)}` : "",
      "STOP repeating this fix. It is not working.",
      "",
    ].filter(Boolean);

    if (strategy <= 2) {
      return [
        ...shared,
        "RE-PLAN before touching that file again:",
        `1. Read \`${target}\` in FULL (not a fragment) so you can see the actual shape of the code.`,
        "2. Read whatever it imports or is typed by — the real cause is usually in the type or the caller, not the line the error points at.",
        "3. State in one sentence what is actually wrong, then make ONE targeted edit.",
        "Do not adjust the same annotation again hoping for a different result.",
      ].join("\n");
    }
    return [
      ...shared,
      "Switch to a SIMPLER, more STRUCTURAL approach:",
      `1. Stop patching individual lines in \`${target}\`.`,
      "2. Either rewrite that unit cleanly with write_file so its shape is correct by construction, or change the approach so the failing construct is not needed at all.",
      "3. If the requirement genuinely cannot be met this way, call ask_user rather than continuing to churn.",
      "Prefer the boring, obvious implementation over the clever one.",
    ].join("\n");
  }

  /**
   * The finish gate.
   *
   * Only runs where it is meaningful: a run that edited nothing (a question, a
   * read-only investigation) is unaffected, which keeps existing behaviour
   * intact. When edits WERE made, verification must have run at least once.
   *
   * Bounded by MAX_VERIFY_PUSHBACKS so a repository with no runnable check
   * cannot trap the agent in a loop — after that the run finishes and the
   * caller reports honestly that it is unverified.
   */
  /**
   * `editedPaths` may be supplied by the caller, which is authoritative: some
   * tools (apply_patch, worktree merges) change files without a `path`
   * argument, so inferring purely from tool args would under-report edits and
   * silently skip the gate on exactly the largest changes.
   */
  /**
   * What the REQUEST asked for that the WORKSPACE does not yet show — checked
   * independently of the agent's own todo list.
   *
   * The plan-based gate has a blind spot it cannot close: it trusts the agent
   * both to write a plan and to tick it honestly. This does not. It compares
   * the shape of the request against what actually changed on disk, which is
   * the only account of the work that the agent cannot narrate its way past.
   *
   * Every check is suppressed when `pathlessMutations` is non-zero: a bash
   * command or an apply_patch changes files this controller cannot attribute,
   * so the evidence is genuinely missing and accusing the agent of skipping
   * work it may well have done would be worse than staying quiet.
   */
  function unmetRequirements(edited) {
    if (!requiresMutation || pathlessMutations > 0) return [];
    const changed = new Set([...edited, ...mutatedPaths]);
    const missing = [];

    if (intent.mentionsTests && ![...changed].some(isTestPath)) {
      missing.push("the request asks for tests, but no test file was created or changed");
    }
    if (intent.mentionsIntegration && integrationEdits === 0) {
      missing.push("the request asks for this to be wired up, but nothing that already existed was modified — whatever you built is not reachable yet");
    }
    // A resume task is defined by unfinished work that ALREADY EXISTS, and the
    // request usually points straight at it. Wiring that file into the app
    // without finishing it satisfies every other requirement here — the
    // integration demand is met (a pre-existing file changed) and the file
    // count is met (resume asks for one) — while the half-built component the
    // user actually asked about is never touched. That was observed: a run
    // whose only change was App.tsx, importing a palette that still had both
    // its TODOs. So for a resume, the named file must itself have moved.
    if (intent.shape === "resume" && intent.named?.length) {
      const changedBases = new Set([...changed].map((p) => String(p).split("/").pop()?.toLowerCase()));
      for (const n of intent.named.filter((n) => !changedBases.has(n))) {
        missing.push(`this is a resume task and the request names ${n}, but that file was never changed — wiring it up is not finishing it`);
      }
    }
    // A ticked-off plan is the agent's own account of its work, not evidence
    // about the workspace — and an agent that stops early is exactly the one
    // whose plan says otherwise. So the file count is checked regardless.
    // This costs at most one turn: the challenge is issued once, and an agent
    // that genuinely finished in one file says so and proceeds.
    if (changed.size > 0 && changed.size < minMutatedFiles) {
      missing.push(`this reads as a ${intent.shape.replace(/_/g, "-")} task, but only ${changed.size} file changed`);
    }
    return missing;
  }

  function canFinish({ editedPaths: authoritative, responseText = "", unresolvedMarkers = [] } = {}) {
    const edited = authoritative ? [...authoritative] : [...editedPaths];
    const mutated = edited.length > 0 || mutations > 0;

    // The run has already been stopped with a failure. The loop normally
    // reports `blockerReport()` and never gets here, but nothing structurally
    // prevented a caller from asking the gate afterwards and being told the
    // run may finish cleanly — two components disagreeing about whether the
    // same run succeeded. There is only one answer, and it was decided already.
    if (stopReason && stopReason !== STOP_REASONS.VERIFIED) {
      // Idempotent: a run's verdict is decided once. Re-asking returns the
      // same answer, flags and all, rather than a freshly-derived one that
      // might have lost the detail explaining WHY it was not a success.
      return settledGate ?? { allowed: true, blocked: true, kind: "already_stopped", reason: stopDetail || stopReason };
    }

    // ── Execution intent gate ──────────────────────────────────────────────
    // The user asked for a change and the workspace is untouched. Reading the
    // repository and describing the fix is not doing it, however good the
    // description is. Refuse the final answer and send the agent back to work.
    //
    // This runs BEFORE the verification gate for the obvious reason: there is
    // nothing to verify until something has actually been written.
    if (requiresMutation && !mutated) {
      if (mutationPushbacks >= MAX_MUTATION_PUSHBACKS) {
        stopReason = STOP_REASONS.BLOCKED;
        stopDetail = "The task asked for a change, but no files were modified after repeated prompting.";
        return (settledGate = { allowed: true, unfulfilled: true, reason: "implementation requested but never applied" });
      }
      mutationPushbacks++;
      const dumpedCode = CODE_BLOCK_RE.test(responseText);
      return {
        allowed: false,
        kind: "no_mutation",
        reason: "action requested but nothing was modified",
        directive: dumpedCode
          ? [
              "STOP — you wrote code as text but did NOT create or edit any files.",
              "The user asked for this change to be APPLIED to their project, not explained.",
              "",
              "Do it now:",
              "1. Use grep / glob / list_files to find the correct file and directory — do not assume paths.",
              "2. Use write_file for new files or edit_file for existing ones, matching this project's stack, imports and conventions.",
              "3. Verify (typecheck/tests), then summarise which files you changed.",
              "Do not paste code as text again — make the edits with the tools.",
            ].join("\n")
          : [
              "Implementation requested. You inspected the repository but did not modify files.",
              "Continue by applying the changes.",
              "",
              "Reading files is not the task. Use write_file or edit_file to make the change real,",
              "then verify it. If something is genuinely ambiguous, call ask_user — but do not",
              "finish by describing what should be done.",
            ].join("\n"),
      };
    }

    // ── Completion gate ────────────────────────────────────────────────────
    // The agent wrote a plan and has not finished it. Stopping at the first
    // edit is the characteristic half-done failure: App.tsx is wired up, the
    // component it imports was never created, and the summary claims success.
    //
    // The plan's own statuses are the definition of done, which keeps this
    // deterministic — the controller never has to judge whether the feature
    // "feels" complete, only whether the agent ticked its own boxes.
    //
    // Runs BEFORE the verification gate on purpose: there is little point
    // typechecking a feature that is still missing half its files.
    if (mutated && openTodos.length > 0) {
      if (completionPushbacks < maxCompletionPushbacks) {
        completionPushbacks++;
        return {
          allowed: false,
          kind: "open_plan_items",
          reason: "the plan still has open items",
          directive: [
            `You are not finished — ${openTodos.length} of ${planItemCount} planned items are still open:`,
            ...openTodos.map((t) => `  ☐ ${t}`),
            "",
            "Making the first edit is not completing the task. Continue with the next open item:",
            "finish the wiring, create any file you referenced but have not written, and add the tests",
            "if the plan called for them.",
            "When an item is genuinely done, mark it completed with todo_write so the list stays honest.",
            "If an item turns out to be unnecessary or impossible, say why — do not leave it silently undone.",
          ].join("\n"),
        };
      }
      // Bounded, like every other gate: report it rather than loop on it.
      incompleteOnFinish = true;
    }

    // ── Shape gate ─────────────────────────────────────────────────────────
    // The plan gate above can only ever be as honest as the plan, and the
    // agent that stops half-way is often the one that never wrote a plan at
    // all — or wrote a three-item plan and ticked all three off after one
    // edit. So the controller also checks the request against the workspace
    // directly: did what the user asked for actually happen?
    //
    // Issued once. If the agent's answer is "yes, that really was all of it",
    // the next call proceeds — this exists to catch the silent half-finish,
    // not to argue with a correct agent.
    const unmet = unmetRequirements(edited);
    if (mutated && unmet.length > 0 && !shapeChallenged) {
      shapeChallenged = true;
      return {
        allowed: false,
        kind: "incomplete_shape",
        reason: "the change does not yet satisfy the request",
        directive: [
          `You are about to finish, but the work does not match what was asked (${intent.shape.replace(/_/g, " ")}):`,
          ...unmet.map((u) => `  ✗ ${u}`),
          "",
          `Changed so far: ${edited.length ? edited.join(", ") : "(nothing tracked)"}`,
          "",
          "Finish the remaining part now — create the missing file, import and use what you built,",
          "or write the tests the request called for. Record what is left with todo_write and keep going.",
          "If one of these genuinely does not apply, say in one line why, then finish.",
        ].join("\n"),
      };
    }
    if (unmet.length > 0) unmetOnFinish = unmet;

    // ── Leftover-marker gate (resume tasks only) ───────────────────────────
    // On a resume, the TODO/FIXME comments sitting in the half-built file ARE
    // the specification — they are how the previous author recorded what is
    // left. Editing that file and leaving its markers in place is the precise
    // shape of "finished the wiring, skipped the behaviour", and no other gate
    // sees it: the file changed, so the count and integration demands are met.
    //
    // Scoped to resume because everywhere else a TODO is ordinary and durable;
    // demanding their removal in general would be a nag, not a check. Issued
    // once, like the shape gate, so an agent whose remaining marker is genuinely
    // out of scope says so and proceeds.
    if (mutated && !markersChallenged && intent.shape === "resume" && unresolvedMarkers.length > 0) {
      markersChallenged = true;
      return {
        allowed: false,
        kind: "unresolved_markers",
        reason: "the half-built work still carries its unfinished-work markers",
        directive: [
          "You edited the half-finished file but left the markers that say what was unfinished:",
          ...unresolvedMarkers.slice(0, 8).map((m) => `  ☐ ${m.file}:${m.line}  ${m.text}`),
          "",
          "On a resume task those comments are the specification — the previous author wrote them",
          "to record exactly what still had to be done. Implement each one now, then delete the",
          "comment. Wiring the component in without implementing its behaviour is not finishing it.",
          "If one genuinely does not apply, say in one line why, then finish.",
        ].join("\n"),
      };
    }
    if (unresolvedMarkers.length > 0) markersOnFinish = unresolvedMarkers.map((m) => `${m.file}:${m.line}`);

    if (edited.length === 0) return { allowed: true, reason: "no edits — nothing to verify" };

    if (!verificationRan()) {
      if (verifyPushbacks >= MAX_VERIFY_PUSHBACKS) {
        return { allowed: true, unverified: true, reason: "verification never ran after repeated prompting" };
      }
      verifyPushbacks++;
      return {
        allowed: false,
        directive: [
          "You have not verified your changes, so you cannot finish yet.",
          `Files you edited: ${edited.join(", ")}`,
          "",
          "Run the check that actually applies to what you changed:",
          "- Frontend/TS edits → the project's typecheck (and lint, if it has one)",
          "- Backend edits → the project's test command, or `node --check <file>` at minimum",
          "- A route or endpoint → start it and `curl` the real endpoint",
          "Discover the real command from the project's own manifest — do not guess a script name.",
          "Run it now, then report what it output.",
        ].join("\n"),
        kind: "unverified",
        reason: "no verification has run",
      };
    }

    // Not "did a check ever pass" but "is what is on disk RIGHT NOW checked".
    if (!verificationCurrent()) {
      const stale = verificationStale();
      if (verifyPushbacks >= MAX_VERIFY_PUSHBACKS) {
        return {
          allowed: true,
          unverified: true,
          reason: stale ? "the workspace changed after the last passing check" : "verification ran but never passed",
        };
      }
      verifyPushbacks++;
      const last = verifications[verifications.length - 1];
      if (stale) {
        return {
          allowed: false,
          kind: "verification_stale",
          reason: "the workspace changed after the last passing check",
          directive: [
            `\`${last.command}\` passed, but you have changed files since then.`,
            "That result certifies a version of the workspace that no longer exists.",
            "",
            "Run it again against what is on disk now, and report what it output.",
          ].join("\n"),
        };
      }
      return {
        allowed: false,
        directive: [
          `Verification is still failing (\`${last.command}\`). You cannot report success yet.`,
          "Fix the failure, then run it again.",
          "If you have already tried the same fix more than once, change approach instead of repeating it.",
        ].join("\n"),
        kind: "verification_failed",
        reason: "verification failed",
      };
    }

    enter("finish");
    stopReason = STOP_REASONS.VERIFIED;
    return {
      allowed: true,
      verified: true,
      reason: "verification passed",
      // Verified, but the agent's own plan says parts were never done. The
      // caller must not present this as an unqualified success.
      ...(incompleteOnFinish ? { incomplete: true, openItems: [...openTodos] } : {}),
      // Allowed through, but the request itself is still not satisfied. The
      // caller must qualify the success rather than present it as whole.
      ...(unmetOnFinish.length ? { unmet: [...unmetOnFinish] } : {}),
    };
  }

  return {
    get state() { return state; },
    get phase() { return currentPhase(); },
    get strategy() { return strategy; },
    get iterations() { return iterations; },
    get stopReason() { return stopReason; },
    get requiresMutation() { return requiresMutation; },
    get shape() { return intent.shape; },
    get intent() { return { ...intent }; },
    get budget() { return { maxDiscoveryTurns, maxIterations, maxNoProgress, minMutatedFiles }; },
    get mutations() { return mutations; },
    recordToolCall,
    recordVerification,
    recall,
    recallRead,
    rememberRead,
    /**
     * Everything this task has learned. Task-lifetime only — it lives and dies
     * with the controller, and nothing here is written to disk.
     */
    memory() {
      return {
        explored: [...explored.entries()].map(([path, r]) => ({ path, ...r })),
        failed: [...failureMemory.values()].map((f) => ({ ...f })),
        fixed: successfulFixes.map((f) => ({ ...f })),
      };
    },
    endIteration,
    blockerReport,
    detectThrash,
    escalateStrategy,
    strategyDirective,
    canFinish,
    snapshot() {
      return {
        state,
        phase: currentPhase(),
        shape: intent.shape,
        intent: { ...intent },
        budget: { maxDiscoveryTurns, maxIterations, maxNoProgress, minMutatedFiles },
        strategy,
        discoveryTurns,
        discoveryCapped,
        discoveryGraceUsed,
        planRevisions,
        iterations,
        noProgressStreak,
        replans,
        requiresMutation,
        mutations,
        mutationPushbacks,
        openTodos: [...openTodos],
        planItemCount,
        completionPushbacks,
        incompleteOnFinish,
        shapeChallenged,
        markersChallenged,
        // Unfinished-work markers still in the tree when the run ended. Empty
        // on every clean resume; non-empty is the run to go and read.
        markersOnFinish,
        unmet: unmetRequirements([...editedPaths]),
        integrationEdits,
        resolvedBlockers,
        exploredFiles: [...explored.keys()],
        successfulFixes: successfulFixes.map((f) => ({ tool: f.tool, target: f.target, after: f.after })),
        failures: [...failureMemory.values()].map((f) => ({ tool: f.tool, target: f.target, reason: f.reason, count: f.count })),
        stopReason,
        stopDetail,
        editedPaths: [...editedPaths],
        inspectedCount: inspectedPaths.size,
        toolCalls: history.length,
        verifications: verifications.map((v) => ({ command: v.command, passed: v.passed })),
        verificationRan: verificationRan(),
        verificationPassed: verificationPassed(),
        // "ever passed" vs "certifies what is on disk now" — different
        // questions, and only the second one may justify claiming success.
        verificationCurrent: verificationCurrent(),
        verificationStale: verificationStale(),
        thrashEvents: thrashEvents.map((e) => ({ signature: e.signature, count: e.count })),
        verifyPushbacks,
      };
    },
  };
}
