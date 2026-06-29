/**
 * answer.mjs
 * ──────────────────────────────────────────────────────────────
 * Handles the "answer" intent branch:
 *   – Casual conversation
 *   – Code questions / explanations
 *   – Architecture advice
 *   – Anything that doesn't require file I/O
 *
 * Streams the response token-by-token via emit() when possible,
 * otherwise returns the full content at once.
 */

import { callLLM, streamLLM } from "../../services/llm.mjs";
import { AIMessage }          from "@langchain/core/messages";

const SYSTEM_PROMPT = `You are Kodo, an expert AI software engineer and coding assistant.
You are embedded directly inside a developer's VS Code workspace.

You help with:
- Explaining code, architecture decisions, and best practices
- Writing code snippets, functions, and components
- Debugging and troubleshooting
- Answering software development questions
- Reviewing approaches and suggesting improvements

Be precise, practical, and concise. Use markdown formatting for code blocks.
When showing code examples, always include the language identifier after the triple backticks.
Do not add unnecessary disclaimers or filler text.`;

export async function answerNode(state) {
  const { userMessage, messages, modelRoute, emit, fileContext } = state;

  emit?.({ type: "progress", stage: "answering", message: "💬 Generating response..." });

  // Build context from fileContext if any files were loaded
  const fileSnippet = (fileContext || [])
    .slice(0, 4) // limit context size
    .map(f => `File: ${f.path}\n\`\`\`\n${f.content?.slice(0, 2000) || ""}\n\`\`\``)
    .join("\n\n");

  const userContent = [
    fileSnippet ? `Relevant project files:\n\n${fileSnippet}` : "",
    userMessage,
  ].filter(Boolean).join("\n\n");

  // Build conversation history (last 10 messages max)
  const historyMessages = (messages || [])
    .filter(m => m instanceof AIMessage || (m.role === "assistant"))
    .slice(-10)
    .map(m => ({
      role:    "assistant",
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    }));

  let finalAnswer = "";

  try {
    // Try streaming first
    const canStream = typeof streamLLM === "function";

    if (canStream) {
      let buffer = "";
      await streamLLM({
        system:   SYSTEM_PROMPT,
        messages: [
          ...historyMessages,
          { role: "user", content: userContent },
        ],
        modelRoute,
        maxTokens:   4000,
        temperature: 0.3,
        onChunk: (chunk) => {
          buffer += chunk;
          emit?.({ type: "content", content: chunk });
        },
      });
      finalAnswer = buffer;
    } else {
      // Non-streaming fallback
      const result = await callLLM({
        system:   SYSTEM_PROMPT,
        messages: [
          ...historyMessages,
          { role: "user", content: userContent },
        ],
        modelRoute,
        maxTokens:   4000,
        temperature: 0.3,
      });

      finalAnswer = result?.content?.trim() || "I couldn't generate a response.";
      emit?.({ type: "content", content: finalAnswer });
    }
  } catch (err) {
    console.error("[Answer] LLM error:", err.message);
    finalAnswer = `Sorry, I encountered an error: ${err.message}`;
    emit?.({ type: "content", content: finalAnswer });
  }

  emit?.({ type: "progress", stage: "answered", message: "✅ Response ready" });

  return {
    finalAnswer,
    messages: [new AIMessage(finalAnswer)],
  };
}
