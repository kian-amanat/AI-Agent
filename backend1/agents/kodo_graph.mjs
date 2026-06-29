/**
 * kodo_graph.mjs
 * ─────────────────────────────────────────────────────────────
 * The core LangGraph StateGraph for the Kodo AI agent.
 *
 * Graph topology:
 *
 *  START
 *    │
 *    ▼
 *  [router]          ← decides which branch to take
 *    │
 *    ├──"explore"──► [explore_workspace]   ← list + read project files
 *    │                       │
 *    │                       ▼
 *    │               [plan_changes]         ← build edit plan
 *    │                       │
 *    │                       ▼
 *    │               [execute_changes]      ← editFile / createFile
 *    │                       │
 *    │                       ▼
 *    │               [verify]               ← run tests / lint / check
 *    │                       │
 *    │               ┌───────┴──────────┐
 *    │           "retry"            "ok"
 *    │               │                  │
 *    │         [execute_changes]       END
 *    │
 *    ├──"answer"───► [answer]          ← casual / code snippet / Q&A
 *    │                       │
 *    │                      END
 *    │
 *    └──"pipeline"─► (calls existing runPipeline)
 *                            │
 *                           END
 *
 * State shape:
 *   messages          – full conversation (HumanMessage / AIMessage)
 *   intent            – "explore" | "answer" | "pipeline"
 *   workspacePath     – resolved workspace root
 *   plan              – array of { action, path, content? }
 *   executionResults  – results from execute step
 *   verifyResult      – { ok, issues }
 *   retryCount        – number of auto-retries
 *   finalAnswer       – string sent back to frontend
 *   sessionId
 *   requestId
 *   userId
 *   modelRoute        – { model, provider, apiKey, baseUrl }
 *   attachmentPaths
 *   fileContext       – relevant file contents built by explore_workspace
 *   emit              – function(event) to stream SSE events (injected at runtime)
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";

import { routerNode }          from "./nodes/router.mjs";
import { exploreWorkspaceNode }from "./nodes/explore_workspace.mjs";
import { planChangesNode }     from "./nodes/plan_changes.mjs";
import { executeChangesNode }  from "./nodes/execute_changes.mjs";
import { verifyNode }          from "./nodes/verify.mjs";
import { answerNode }          from "./nodes/answer.mjs";
import { pipelineNode }        from "./nodes/pipeline_node.mjs";

// ─── State annotation ─────────────────────────────────────────
// LangGraph JS uses a plain schema object with reducer functions.
// We keep it simple: last-write-wins for everything except messages.

export const KodoStateAnnotation = {
  // conversation history – appended each step
  messages: {
    default: () => [],
    reducer: (prev, next) =>
      Array.isArray(next) ? [...prev, ...next] : [...prev, next],
  },
  // routing
  intent: { default: () => "" },
  // workspace
  workspacePath: { default: () => "" },
  fileContext: { default: () => [] },   // [{ path, content, summary }]
  // planning & execution
  plan: { default: () => [] },          // [{ action, path, content?, description }]
  executionResults: { default: () => [] },
  verifyResult: { default: () => null },
  retryCount: { default: () => 0 },
  // final output
  finalAnswer: { default: () => "" },
  // request metadata
  sessionId: { default: () => "" },
  requestId: { default: () => "" },
  userId: { default: () => "" },
  modelRoute: { default: () => ({}) },
  attachmentPaths: { default: () => [] },
  userMessage: { default: () => "" },
  rememberedTargetFile: {
    default: () => "",
    // Persist across nodes: keep the existing value unless a node
    // explicitly provides a new non-empty one.
    reducer: (prev, next) => (next !== undefined && next !== "" ? next : prev),
  },
  // SSE emitter (injected at runtime — NOT serialised)
  emit: { default: () => null },
};

// ─── Edge condition: after router ─────────────────────────────
function routerEdge(state) {
  const intent = state.intent || "answer";
  if (intent === "explore")  return "explore_workspace";
  if (intent === "pipeline") return "pipeline";
  return "answer";
}

// ─── Edge condition: after verify ─────────────────────────────
function verifyEdge(state) {
  const MAX_RETRIES = 2;
  if (!state.verifyResult?.ok && state.retryCount < MAX_RETRIES) {
    return "execute_changes"; // retry
  }
  return END;
}

// ─── Build graph ──────────────────────────────────────────────
export function buildKodoGraph() {
  const graph = new StateGraph({ channels: KodoStateAnnotation });

  // Register nodes
  graph
    .addNode("router",            routerNode)
    .addNode("explore_workspace", exploreWorkspaceNode)
    .addNode("plan_changes",      planChangesNode)
    .addNode("execute_changes",   executeChangesNode)
    .addNode("verify",            verifyNode)
    .addNode("answer",            answerNode)
    .addNode("pipeline",          pipelineNode);

  // Entry
  graph.addEdge(START, "router");

  // Router branches
  graph.addConditionalEdges("router", routerEdge, {
    explore_workspace: "explore_workspace",
    pipeline:          "pipeline",
    answer:            "answer",
  });

  // Explore → Plan → Execute → Verify
  graph.addEdge("explore_workspace", "plan_changes");
  graph.addEdge("plan_changes",      "execute_changes");
  graph.addEdge("execute_changes",   "verify");

  // Verify: retry or done
  graph.addConditionalEdges("verify", verifyEdge, {
    execute_changes: "execute_changes",
    [END]: END,
  });

  // Terminal nodes
  graph.addEdge("answer",   END);
  graph.addEdge("pipeline", END);

  return graph.compile();
}
