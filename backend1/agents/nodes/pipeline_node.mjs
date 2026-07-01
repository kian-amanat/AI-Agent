/**
 * pipeline_node.mjs
 * Bridges the LangGraph graph to runPipeline.
 */

import { AIMessage } from "@langchain/core/messages";

export async function pipelineNode(state) {
  const {
    userMessage,
    sessionId,
    requestId,
    attachmentPaths,
    workspacePath,
    emit,
  } = state;

  emit?.({
    type: "progress",
    stage: "pipeline_start",
    message: "🚀 Starting full development pipeline...",
  });

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
    type: "progress",
    stage: "planning",
    message: "📋 Phase 1/5: Starting architecture and generation...",
  });

  try {
    await runPipeline({
      message: userMessage,
      sessionId: sessionId || "",
      requestId: requestId || `req_${Date.now()}`,
      attachmentPaths: attachmentPaths || [],
      audioPath: "",
      workspacePath: workspacePath || "",
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
    type: "progress",
    stage: "pipeline_done",
    message: finalAnswer,
  });

  return {
    finalAnswer,
    messages: [new AIMessage(finalAnswer)],
  };
}