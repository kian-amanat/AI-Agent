/**
 * pipeline_node.mjs
 * ──────────────────────────────────────────────────────────────
 * Bridges the LangGraph graph to your existing runPipeline service.
 * Used for complex "build a full feature/app" requests that need
 * the full planner → codegen pipeline.
 *
 * Imports runPipeline from services/pipeline.service.mjs and
 * feeds it the same arguments as before, so nothing breaks.
 */

import { AIMessage } from "@langchain/core/messages";

export async function pipelineNode(state) {
  const {
    userMessage,
    sessionId,
    requestId,
    attachmentPaths,
    workspacePath,
    modelRoute,
    emit,
  } = state;

  emit?.({
    type:    "progress",
    stage:   "pipeline_start",
    message: "🚀 Starting full development pipeline...",
  });

  // Dynamic import so this file can be loaded even if runPipeline
  // is not available in isolated test environments.
  let runPipeline;
  try {
    const mod = await import("../../services/pipeline.service.mjs");
    runPipeline = mod.runPipeline;
  } catch (err) {
    const msg = `Pipeline service unavailable: ${err.message}`;
    console.error("[PipelineNode]", msg);
    emit?.({ type: "error", error: msg });
    return {
      finalAnswer: msg,
      messages: [new AIMessage(msg)],
    };
  }

  emit?.({
    type:    "progress",
    stage:   "planning",
    message: "📋 Phase 1/5: Planning architecture...",
  });

  try {
    await runPipeline({
      message:         userMessage,
      sessionId:       sessionId || "",
      requestId:       requestId || `req_${Date.now()}`,
      attachmentPaths: attachmentPaths || [],
      audioPath:       "",
      workspacePath:   workspacePath || "",
    });
  } catch (pipelineError) {
    const msg = `Pipeline failed: ${pipelineError.message}`;
    console.error("[PipelineNode]", msg);
    emit?.({ type: "error", error: msg });
    return {
      finalAnswer: msg,
      messages: [new AIMessage(msg)],
    };
  }

  const finalAnswer = "✅ Full development pipeline completed. Your code has been generated and saved to the workspace.";

  emit?.({
    type:    "progress",
    stage:   "pipeline_done",
    message: finalAnswer,
  });

  return {
    finalAnswer,
    messages: [new AIMessage(finalAnswer)],
  };
}
