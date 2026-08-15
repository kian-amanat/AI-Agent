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
  priorMessages = [],
  priorConversation = [],
  recordEvent = null,
  sessionId,
  requestId,
  userId,
  workspacePath,
  modelRoute,
  visionRoute,
  attachmentPaths = [],
  emit,
  abortSignal = null,
  permissionMode = "auto",
  approvalPromise = null,
  askUser = null,
  // The ExecutionRuntime every tool executes through. Omitted means the host —
  // which is the correct default for a tool you ran in your own terminal. A
  // sandboxed caller builds one with core/runtime's createRuntime(), which
  // refuses to hand back a runtime that could not prove isolation.
  runtime = null,
}) {
  const graph = getGraph();

  const initialState = {
    messages:        [new HumanMessage(userMessage)],
    intent:          "",
    userMessage,
    rememberedTargetFile,
    priorMessages,
    priorConversation,
    recordEvent,
    workspacePath,
    finalAnswer:     "",
    editedFiles:     [],
    usage:           null,
    runMetrics:      null,
    sessionId,
    requestId,
    userId,
    modelRoute,
    visionRoute,
    attachmentPaths,
    emit,
    abortSignal,
    permissionMode,
    approvalPromise,
    askUser,
    runtime,
  };

  console.log(`[KodoGraph] 🚀 session=${sessionId} request=${requestId}`);
  console.log(`[KodoGraph]    workspace=${workspacePath || "(none)"}`);
  console.log(`[KodoGraph]    runtime=${runtime?.name || "host"}${runtime?.isolated ? " (isolated)" : ""}`);
  console.log(`[KodoGraph]    remembered file=${rememberedTargetFile || "(none)"}`);
  console.log(`[KodoGraph]    prior turns=${priorConversation.length || priorMessages.length}${priorConversation.length ? " (tool timeline)" : ""}`);
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
  const runMetrics  = finalState?.runMetrics || null;

  // Note: abortSignal cleanup is handled in plannerAgent.mjs after runKodoGraph resolves
  console.log(`[KodoGraph] ✅ Done. Answer=${finalAnswer.length} chars, editedFiles=${editedFiles.length}`);

  return { finalAnswer, editedFiles, usage, runMetrics };
}
