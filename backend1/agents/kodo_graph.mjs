/**
 * kodo_graph.mjs
 *
 * Graph topology (Claude Code refactor — one agent, no phases):
 *
 *   START
 *     ↓
 *   router
 *     ├── answer      (greetings / questions / conversation — streams)
 *     │      ↓
 *     │   ├── END          (normal: it answered)
 *     │   └── agent_loop   (escalation: the request actually needs workspace
 *     │                     tools — answer can't edit, so it hands off)
 *     └── agent_loop  (EVERYTHING else: edits, bugs, tests, installs,
 *                      multi-step work — one unified tool loop that
 *                      reads, edits, runs commands, and verifies itself)
 *               ↓
 *              END
 *
 * The answer → agent_loop escalation edge fixes the one asymmetric failure:
 * agent_loop is a superset of answer (it can also just talk), so misrouting
 * chat to agent_loop is harmless, but misrouting real work to answer used to
 * dead-end. Now answer emits an __ESCALATE__ sentinel and hands off instead.
 *
 * The old explore → plan → execute → verify pipeline, the regex intent
 * router, and the multi-task decomposer are gone: the agent loop plans
 * with a todo list, edits incrementally with edit_file/write_file, and
 * verifies by running real commands via bash.
 */

import { StateGraph, END, START } from "@langchain/langgraph";

import { routerNode }    from "./nodes/router.mjs";
import { agentLoopNode } from "./nodes/agent_loop.mjs";
import { answerNode }    from "./nodes/answer.mjs";

// ── State annotation ──────────────────────────────────────────────────────────

export const KodoStateAnnotation = {
  messages: {
    default: () => [],
    reducer: (prev, next) =>
      Array.isArray(next) ? [...prev, ...next] : [...prev, next],
  },

  intent: { default: () => "" },

  // Request context
  workspacePath:   { default: () => "" },
  userMessage:     { default: () => "" },
  attachmentPaths: { default: () => [] },
  modelRoute:      { default: () => ({}) },
  sessionId:       { default: () => "" },
  requestId:       { default: () => "" },
  userId:          { default: () => "" },

  // The last file the user worked on (carried across turns)
  rememberedTargetFile: {
    default: () => "",
    reducer: (prev, next) => (next !== undefined && next !== "" ? next : prev),
  },

  // Outputs
  finalAnswer: { default: () => "" },
  editedFiles: { default: () => [] },
  usage:       { default: () => null },

  // Set by the answer node when it detects the request actually needs
  // workspace tools — routes answer → agent_loop instead of END.
  escalate:    { default: () => false },

  // Runtime plumbing — injected by graph_runner, never serialised
  emit:            { default: () => null },
  abortSignal:     { default: () => null },
  permissionMode:  { default: () => "auto" },
  approvalPromise: { default: () => null },
  // Lets agent_loop's ask_user tool pause and surface a question to the user
  // mid-task, the same way approvalPromise gates a mutation — a function
  // ({question, header, options}) => Promise<answer>, injected by graph_runner.
  askUser:         { default: () => null },
};

// ── Error boundary ────────────────────────────────────────────────────────────

function withErrorBoundary(nodeName, fn) {
  return async (state) => {
    try {
      return await fn(state);
    } catch (err) {
      console.error(`[${nodeName}] ❌ Unhandled error:`, err.message);
      const msg = `Something went wrong in the ${nodeName} step: ${err.message}`;
      state.emit?.({ type: "content", content: msg });
      return { finalAnswer: msg };
    }
  };
}

// ── Graph factory ─────────────────────────────────────────────────────────────

export function buildKodoGraph() {
  const graph = new StateGraph({ channels: KodoStateAnnotation });

  graph
    .addNode("router",     withErrorBoundary("router",     routerNode))
    .addNode("agent_loop", withErrorBoundary("agent_loop", agentLoopNode))
    .addNode("answer",     withErrorBoundary("answer",     answerNode));

  graph.addEdge(START, "router");

  graph.addConditionalEdges(
    "router",
    (state) => (state.intent === "answer" ? "answer" : "agent_loop"),
    { answer: "answer", agent_loop: "agent_loop" }
  );

  graph.addEdge("agent_loop", END);

  // answer either finishes (END) or escalates into the agent loop.
  graph.addConditionalEdges(
    "answer",
    (state) => (state.escalate ? "agent_loop" : END),
    { agent_loop: "agent_loop", [END]: END }
  );

  return graph.compile();
}
