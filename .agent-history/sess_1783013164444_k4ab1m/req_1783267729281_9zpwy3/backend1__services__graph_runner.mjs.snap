/**
 * services/graph_runner.mjs
 * Instantiates and runs the Kodo LangGraph for a single request.
 * Returns finalAnswer + editedFiles (so the route can save the
 * primary target file into memory for the next turn).
 */

import { buildKodoGraph }  from "../agents/kodo_graph.mjs";
import { HumanMessage }    from "@langchain/core/messages";

let compiledGraph = null;
function getGraph() {
  if (!compiledGraph) compiledGraph = buildKodoGraph();
  return compiledGraph;
}

export async function runKodoGraph({
  userMessage,
  rememberedTargetFile = "",   // ★ NEW: last file the user worked on
  sessionId,
  requestId,
  userId,
  workspacePath,
  modelRoute,
  attachmentPaths = [],
  emit,
}) {
  const graph = getGraph();

  const initialState = {
    messages:        [new HumanMessage(userMessage)],
    intent:          "",
    userMessage,
    rememberedTargetFile,        // ★ passed into explore node
    workspacePath,
    fileContext:     [],
    plan:            [],
    executionResults:[],
    verifyResult:    null,
    retryCount:      0,
    finalAnswer:     "",
    sessionId,
    requestId,
    userId,
    modelRoute,
    attachmentPaths,
    emit,
  };

  console.log(`[KodoGraph] 🚀 session=${sessionId} request=${requestId}`);
  console.log(`[KodoGraph]    workspace=${workspacePath || "(none)"}`);
  console.log(`[KodoGraph]    remembered file=${rememberedTargetFile || "(none)"}`);
  console.log(`[KodoGraph]    message="${String(userMessage).slice(0, 80)}"`);

  let finalState;
  try {
    finalState = await graph.invoke(initialState);
  } catch (err) {
    console.error("[KodoGraph] ❌ Graph error:", err);
    emit?.({ type: "error", error: err.message });
    return { finalAnswer: `Graph error: ${err.message}`, editedFiles: [] };
  }

  const finalAnswer = finalState?.finalAnswer || "";

  // Extract which files were actually edited/created (for memory)
  const editedFiles = (finalState?.executionResults || [])
    .filter(r => r.success && (r.action === "edit" || r.action === "create") && r.path)
    .map(r => r.path);

  console.log(`[KodoGraph] ✅ Done. Answer=${finalAnswer.length} chars, editedFiles=${editedFiles.length}`);

  return { finalAnswer, editedFiles };
}
