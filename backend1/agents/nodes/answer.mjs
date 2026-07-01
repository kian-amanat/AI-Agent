/**
 * answer.mjs
 * Handles non-editing intent: greetings, questions, explanations,
 * code advice, debugging help, and casual conversation.
 */

import { callLLM, streamLLM } from "../../services/llm.mjs";
import { AIMessage } from "@langchain/core/messages";

const SYSTEM_PROMPT = `You are Kodo, an AI coding assistant embedded inside a developer's VS Code workspace.

PERSONALITY
- Direct and concise.
- Warm but professional.
- Honest. If something is uncertain, say so briefly.

CAPABILITIES
- Answer coding questions.
- Explain concepts.
- Suggest architecture and best practices.
- Help debug and troubleshoot.
- Discuss developer workflows.

RULES
- Never start with "I".
- Do not use filler phrases like "Certainly", "Of course", "Great question", "Absolutely".
- Keep greetings short.
- For technical questions, be structured and useful.
- Do not mention inability to edit files here; file editing is handled by the workspace pipeline.
- Do not write code blocks unless the user explicitly asks for code.`;

function cleanMessage(input) {
  return String(input || "").split(/conversation memory:/i)[0].trim();
}

function buildFileContextSnippet(fileContext = []) {
  const top = (fileContext || []).slice(0, 3);
  if (!top.length) return "";

  return top
    .map((f) => {
      const preview = String(f.content || "").slice(0, 1200);
      const summary = f.summary ? `Summary: ${f.summary}\n` : "";
      return `File: ${f.path}\n${summary}\`\`\`\n${preview}\n\`\`\``;
    })
    .join("\n\n");
}

function buildHistoryMessages(messages = []) {
  return (messages || [])
    .filter((m) => m && (m instanceof AIMessage || m.role === "assistant"))
    .slice(-8)
    .map((m) => ({
      role: "assistant",
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    }));
}

export async function answerNode(state) {
  const { userMessage, messages, modelRoute, emit, fileContext } = state;

  emit?.({
    type: "progress",
    stage: "answering",
    message: "💬 Generating response...",
  });

  const cleanUserMessage = cleanMessage(userMessage);
  const fileSnippet = buildFileContextSnippet(fileContext);

  const userContent = [
    fileSnippet ? `Relevant project files:\n\n${fileSnippet}` : "",
    cleanUserMessage,
  ]
    .filter(Boolean)
    .join("\n\n");

  const historyMessages = buildHistoryMessages(messages);

  try {
    const canStream = typeof streamLLM === "function";

    if (canStream) {
      let buffer = "";

      await streamLLM({
        system: SYSTEM_PROMPT,
        messages: [
          ...historyMessages,
          { role: "user", content: userContent },
        ],
        modelRoute,
        maxTokens: 1400,
        temperature: 0.35,
        onChunk: (chunk) => {
          buffer += chunk;
          emit?.({ type: "content", content: chunk });
        },
      });

      return {
        finalAnswer: buffer,
        messages: [new AIMessage(buffer)],
      };
    }

    const result = await callLLM({
      system: SYSTEM_PROMPT,
      messages: [
        ...historyMessages,
        { role: "user", content: userContent },
      ],
      modelRoute,
      maxTokens: 1400,
      temperature: 0.35,
    });

    const finalAnswer = result?.content?.trim() || "I couldn't generate a response.";
    emit?.({ type: "content", content: finalAnswer });

    return {
      finalAnswer,
      messages: [new AIMessage(finalAnswer)],
    };
  } catch (err) {
    const finalAnswer = `Sorry, I ran into an error: ${err.message}`;
    console.error("[Answer] LLM error:", err);
    emit?.({ type: "content", content: finalAnswer });

    return {
      finalAnswer,
      messages: [new AIMessage(finalAnswer)],
    };
  }
}