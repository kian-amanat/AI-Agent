/**
 * kodo_graph.mjs
 *
 * START
 *   ↓
 * router
 *   ├── answer
 *   ├── pipeline
 *   ├── run_tests
 *   ├── install_packages
 *   └── investigate / explore
 *             ↓
 *      investigate_workspace
 *             ↓
 *        workspace_index
 *             ↓
 *       stacktrace_parser
 *             ↓
 *        symbol_search
 *             ↓
 *         grep_workspace
 *             ↓
 *      dependency_context
 *             ↓
 *        plan_changes
 *             ↓
 *      execute_changes
 *             ↓
 *          verify
 *             │
 *      retry plan if needed
 *             │
 *            END
 */

import { StateGraph, END, START } from "@langchain/langgraph";

import { routerNode } from "./nodes/router.mjs";
import {
  investigateWorkspaceNode,
  exploreWorkspaceNode,
} from "./nodes/investigate_workspace.mjs";
import { workspaceIndexNode } from "./nodes/workspace_index.mjs";
import { stacktraceParserNode } from "./nodes/stacktrace_parser.mjs";
import { symbolSearchNode } from "./nodes/symbol_search.mjs";
import { grepWorkspaceNode } from "./nodes/grep_workspace.mjs";
import { dependencyContextNode } from "./nodes/dependency_context.mjs";
import { planChangesNode } from "./nodes/plan_changes.mjs";
import { executeChangesNode } from "./nodes/execute_changes.mjs";
import { verifyNode } from "./nodes/verify.mjs";
import { answerNode } from "./nodes/answer.mjs";
import { pipelineNode } from "./nodes/pipeline_node.mjs";
import { runTestsNode } from "./nodes/run_tests.mjs";
import { installPackagesNode } from "./nodes/install_packages.mjs";

export const KodoStateAnnotation = {
  messages: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) ? [...prev, ...next] : [...prev, next]),
  },

  intent: {
    default: () => "",
  },

  workspacePath: {
    default: () => "",
  },

  userMessage: {
    default: () => "",
  },

  attachmentPaths: {
    default: () => [],
  },

  modelRoute: {
    default: () => ({}),
  },

  sessionId: {
    default: () => "",
  },

  requestId: {
    default: () => "",
  },

  userId: {
    default: () => "",
  },

  rememberedTargetFile: {
    default: () => "",
    reducer: (prev, next) => (next !== undefined && next !== "" ? next : prev),
  },

  fileContext: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  investigation: {
    default: () => null,
    reducer: (prev, next) => next ?? prev,
  },

  workspaceIndex: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  stackTraceFiles: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  stackTraceSymbols: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  symbolMatches: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  locatedFiles: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  dependencyFiles: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  dependencyHints: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  grepResults: {
    default: () => [],
    reducer: (prev, next) => (Array.isArray(next) && next.length ? next : prev),
  },

  rootCause: {
    default: () => null,
    reducer: (prev, next) => next ?? prev,
  },

  repairReason: {
    default: () => null,
    reducer: (prev, next) => next ?? prev,
  },

  plan: {
    default: () => [],
  },

  testReport: {
    default: () => null,
    reducer: (prev, next) => next ?? prev,
  },

  executionResults: {
    default: () => [],
  },

  verifyResult: {
    default: () => null,
  },

  retryCount: {
    default: () => 0,
  },

  finalAnswer: {
    default: () => "",
  },

  emit: {
    default: () => null,
  },
};

function routerEdge(state) {
  switch (state.intent) {
    case "investigate":
      return "investigate_workspace";
    case "explore":
      return "explore_workspace";
    case "pipeline":
      return "pipeline";
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
    console.log(`[Graph] Retry ${state.retryCount + 1}/${MAX_RETRIES}`);
    return "plan_changes";
  }
  return END;
}

export function buildKodoGraph() {
  const graph = new StateGraph({ channels: KodoStateAnnotation });

  graph
    .addNode("router", routerNode)
    .addNode("investigate_workspace", investigateWorkspaceNode)
    .addNode("explore_workspace", exploreWorkspaceNode)
    .addNode("workspace_index", workspaceIndexNode)
    .addNode("stacktrace_parser", stacktraceParserNode)
    .addNode("symbol_search", symbolSearchNode)
    .addNode("grep_workspace", grepWorkspaceNode)
    .addNode("dependency_context", dependencyContextNode)
    .addNode("plan_changes", planChangesNode)
    .addNode("execute_changes", executeChangesNode)
    .addNode("verify", verifyNode)
    .addNode("answer", answerNode)
    .addNode("pipeline", pipelineNode)
    .addNode("run_tests", runTestsNode)
    .addNode("install_packages", installPackagesNode);

  graph.addEdge(START, "router");

  graph.addConditionalEdges("router", routerEdge, {
    investigate_workspace: "investigate_workspace",
    explore_workspace: "explore_workspace",
    pipeline: "pipeline",
    answer: "answer",
    run_tests: "run_tests",
    install_packages: "install_packages",
  });

  graph.addEdge("run_tests", END);
  graph.addEdge("install_packages", END);

  graph.addEdge("investigate_workspace", "workspace_index");
  graph.addEdge("explore_workspace", "workspace_index");
  graph.addEdge("workspace_index", "stacktrace_parser");
  graph.addEdge("stacktrace_parser", "symbol_search");
  graph.addEdge("symbol_search", "grep_workspace");
  graph.addEdge("grep_workspace", "dependency_context");
  graph.addEdge("dependency_context", "plan_changes");

  graph.addEdge("plan_changes", "execute_changes");
  graph.addEdge("execute_changes", "verify");

  graph.addConditionalEdges("verify", verifyEdge, {
    plan_changes: "plan_changes",
    [END]: END,
  });

  graph.addEdge("answer", END);
  graph.addEdge("pipeline", END);

  return graph.compile();
}