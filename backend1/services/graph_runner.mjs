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
  rememberedTargetFile = "",
  sessionId,
  requestId,
  userId,
  workspacePath,
  modelRoute,
  attachmentPaths = [],
  emit,
  abortSignal = null,
  permissionMode = "auto",
  approvalPromise = null,
}) {
  const graph = getGraph();

  const initialState = {
    messages:        [new HumanMessage(userMessage)],
    intent:          "",
    userMessage,
    rememberedTargetFile,
    workspacePath,
    finalAnswer:     "",
    editedFiles:     [],
    usage:           null,
    sessionId,
    requestId,
    userId,
    modelRoute,
    attachmentPaths,
    emit,
    abortSignal,
    permissionMode,
    approvalPromise,
  };

  console.log(`[KodoGraph] 🚀 session=${sessionId} request=${requestId}`);
  console.log(`[KodoGraph]    workspace=${workspacePath || "(none)"}`);
  console.log(`[KodoGraph]    remembered file=${rememberedTargetFile || "(none)"}`);
  console.log(`[KodoGraph]    message="${String(userMessage).slice(0, 80)}"`);

    let finalState;
  try {
    // Check if already aborted before starting
    if (abortSignal?.aborted) {
      throw new Error("Aborted");
    }

    finalState = await graph.invoke(initialState);
  } catch (err) {
    // Handle abort specifically
    if (err.message === "Aborted" || (abortSignal?.aborted)) {
      console.log("[KodoGraph] ⛔ Graph execution aborted");
      emit?.({ type: "content", content: "Operation cancelled." });
      return { finalAnswer: "Operation cancelled.", editedFiles: [] };
    }
    console.error("[KodoGraph] ❌ Graph error:", err);
    emit?.({ type: "error", error: err.message });
    return { finalAnswer: `Graph error: ${err.message}`, editedFiles: [] };
  }

  const finalAnswer = finalState?.finalAnswer || "";
  const editedFiles = Array.isArray(finalState?.editedFiles) ? finalState.editedFiles : [];
  const usage       = finalState?.usage || null;

  // Note: abortSignal cleanup is handled in plannerAgent.mjs after runKodoGraph resolves
  console.log(`[KodoGraph] ✅ Done. Answer=${finalAnswer.length} chars, editedFiles=${editedFiles.length}`);

  return { finalAnswer, editedFiles, usage };
}
