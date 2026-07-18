/**
 * kodo_graph.mjs
 *
 * Graph topology (Claude Code refactor — one agent, no phases):
 *
 *   START
 *     ↓
 *   router
 *     ├── answer      (greetings / questions / conversation — streams)
 *     └── agent_loop  (EVERYTHING else: edits, bugs, tests, installs,
 *                      multi-step work — one unified tool loop that
 *                      reads, edits, runs commands, and verifies itself)
 *               ↓
 *              END
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

  // Runtime plumbing — injected by graph_runner, never serialised
  emit:            { default: () => null },
  abortSignal:     { default: () => null },
  permissionMode:  { default: () => "auto" },
  approvalPromise: { default: () => null },
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
  graph.addEdge("answer", END);

  return graph.compile();
}
