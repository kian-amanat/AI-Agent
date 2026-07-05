/**
 * kodo_graph.mjs
 *
 * Graph topology (post-agentic-loop refactor):
 *
 *   START
 *     ↓
 *   router
 *     ├── answer          (questions / greetings)
 *     ├── pipeline        (full project scaffolding)
 *     ├── run_tests       ("run tests")
 *     ├── install_packages ("install X")
 *     └── agentic_explore (all code edits and bug fixes)
 *               ↓
 *         plan_changes     (LLM plans patches from gathered context)
 *               ↓
 *        execute_changes   (applies patches to disk)
 *               ↓
 *            verify        (file existence, lint, typecheck, tests)
 *               │
 *     re-plan if issues (≤ 2 retries, feeding fresh file context)
 *               │
 *              END
 *
 * The key change: the former rigid chain
 *   investigate_workspace → workspace_index → stacktrace_parser →
 *   symbol_search → grep_workspace → dependency_context
 * is replaced by a single agenticExploreNode where the model calls
 * tools (read_file, grep_code, list_files) iteratively until it has
 * gathered enough context to plan with confidence.
 */

import { StateGraph, END, START } from "@langchain/langgraph";

import { routerNode }         from "./nodes/router.mjs";
import { agenticExploreNode } from "./nodes/agentic_explore.mjs";
import { planChangesNode }    from "./nodes/plan_changes.mjs";
import { executeChangesNode } from "./nodes/execute_changes.mjs";
import { verifyNode }         from "./nodes/verify.mjs";
import { answerNode }         from "./nodes/answer.mjs";
import { runTestsNode }       from "./nodes/run_tests.mjs";
import { installPackagesNode} from "./nodes/install_packages.mjs";

// ── State annotation ──────────────────────────────────────────────────────────

export const KodoStateAnnotation = {
  // Conversation history
  messages: {
    default: () => [],
    reducer: (prev, next) =>
      Array.isArray(next) ? [...prev, ...next] : [...prev, next],
  },

  // Routing
  intent: { default: () => "" },

  // Request context
  workspacePath:   { default: () => "" },
  userMessage:     { default: () => "" },
  attachmentPaths: { default: () => [] },
  modelRoute:      { default: () => ({}) },
  sessionId:       { default: () => "" },
  requestId:       { default: () => "" },
  userId:          { default: () => "" },

  // Memory: the last file the user worked on (carried across turns)
  rememberedTargetFile: {
    default: () => "",
    reducer: (prev, next) =>
      next !== undefined && next !== "" ? next : prev,
  },

  // Exploration output → consumed by plan_changes
  fileContext: {
    default: () => [],
    reducer: (prev, next) =>
      Array.isArray(next) && next.length ? next : prev,
  },
  investigation: {
    default: () => null,
    reducer: (prev, next) => next ?? prev,
  },

  // Plan + execution
  plan:             { default: () => [] },
  executionResults: { default: () => [] },

  // Verification
  verifyResult: { default: () => null },
  retryCount:   { default: () => 0 },

  // Test runner output
  testReport: {
    default: () => null,
    reducer: (prev, next) => next ?? prev,
  },

  // Final streamed answer
  finalAnswer: { default: () => "" },

    // SSE emitter — injected by graph_runner, never serialised
  emit: { default: () => null },

  // AbortController signal for cancellation
  abortSignal: { default: () => null },
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

// ── Edge functions ────────────────────────────────────────────────────────────

function routerEdge(state) {
  switch (state.intent) {
    case "investigate":
    case "explore":
    case "pipeline":
      return "agentic_explore";
    case "test":
      return "run_tests";
    case "install":
      return "install_packages";
    default:
      return "answer";
  }
}

function verifyEdge(state) {
  const MAX_RETRIES = 2;
  if (!state.verifyResult?.ok && (state.retryCount || 0) < MAX_RETRIES) {
    console.log(`[Graph] Verify failed — retry ${state.retryCount}/${MAX_RETRIES}`);
    return "plan_changes";
  }
  return END;
}

// ── Graph factory ─────────────────────────────────────────────────────────────

export function buildKodoGraph() {
  const graph = new StateGraph({ channels: KodoStateAnnotation });

  graph
    .addNode("router",           withErrorBoundary("router",          routerNode))
    .addNode("agentic_explore",  withErrorBoundary("agentic_explore", agenticExploreNode))
    .addNode("plan_changes",     withErrorBoundary("plan_changes",    planChangesNode))
    .addNode("execute_changes",  withErrorBoundary("execute_changes", executeChangesNode))
    .addNode("verify",           withErrorBoundary("verify",          verifyNode))
    .addNode("answer",           withErrorBoundary("answer",          answerNode))
    .addNode("run_tests",        withErrorBoundary("run_tests",       runTestsNode))
    .addNode("install_packages", withErrorBoundary("install_packages",installPackagesNode));

  // Entry point
  graph.addEdge(START, "router");

  // Router dispatches to one of five paths
  graph.addConditionalEdges("router", routerEdge, {
    agentic_explore:  "agentic_explore",
    answer:           "answer",
    run_tests:        "run_tests",
    install_packages: "install_packages",
  });

  // Code-edit pipeline: explore → plan → execute → verify → (retry | done)
  graph.addEdge("agentic_explore", "plan_changes");
  graph.addEdge("plan_changes",    "execute_changes");
  graph.addEdge("execute_changes", "verify");

  graph.addConditionalEdges("verify", verifyEdge, {
    plan_changes: "plan_changes",
    [END]:        END,
  });

  // Terminal nodes
  graph.addEdge("answer",           END);
  graph.addEdge("run_tests",        END);
  graph.addEdge("install_packages", END);

  return graph.compile();
}
