/**
 * answer.mjs
 * Handles non-editing intent: greetings, questions, explanations,
 * code advice, debugging help, and casual conversation.
 *
 * Memory integration (Claude Code approach):
 *  - MEMORY.md index is already in userMessage (injected by plannerAgent)
 *  - Before answering: pre-load full content of relevant topic files
 *  - "forget/clear memory" commands are handled here without hitting the LLM
 */

import { callLLM, streamLLM } from "../../services/llm.mjs";
import { AIMessage } from "@langchain/core/messages";
import {
  loadRelevantTopics,
  deleteMemoryTopic,
  clearAllMemory,
  listMemoryTopics,
  writeFactDirectly,
} from "../../services/agentMemory.mjs";

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
- For technical questions, be structured and useful — include code snippets and examples whenever they make the answer clearer.
- Do not mention inability to edit files here; if the user actually wants files changed, the agent pipeline handles it in a separate mode.`;

// Detect explicit memory-management commands (not general questions about memory)
function isForgetCommand(msg) {
  return /\b(?:forget|clear|wipe)\s+(?:all\s+)?(?:memory|memories)\b|\bforget\s+(?:the\s+)?\w[\w-]*\s+memory\b|\bclear\s+memory\s+topic\b/i.test(msg);
}

const FORGET_ALL_RE = /\b(?:forget|clear|wipe|reset)\s+all\s+(?:memory|memories)\b/i;

async function handleForgetCommand(workspacePath, cleanUserMessage) {
  if (FORGET_ALL_RE.test(cleanUserMessage)) {
    await clearAllMemory(workspacePath);
    return "All memory cleared.";
  }

  const topics = await listMemoryTopics(workspacePath);
  if (topics.length === 0) {
    return "No memory topics exist yet.";
  }

  const msg = cleanUserMessage.toLowerCase();
  const matched = topics.find(t => msg.includes(t.toLowerCase()));
  if (matched) {
    await deleteMemoryTopic(workspacePath, matched);
    return `Forgot everything in the "${matched}" memory topic.`;
  }

  return `Which memory topic should I forget? Available:\n${topics.map(t => `- ${t}`).join("\n")}`;
}

// Strip appended memory/context sections to get the raw user message
function cleanMessage(input) {
  return String(input || "")
    .split(/(?:conversation memory:|agent memory:)/i)[0]
    .trim();
}

function buildMemorySection(topics) {
  const entries = Object.entries(topics);
  if (!entries.length) return "";
  return entries
    .map(([name, content]) => {
      const stripped = String(content).replace(/^---[\s\S]*?---\n+/, "").trimStart();
      return `=== Memory: ${name} ===\n${stripped.slice(0, 1000)}`;
    })
    .join("\n\n");
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
  const { userMessage, messages, modelRoute, emit, fileContext, workspacePath, rememberedTargetFile } = state;

  const cleanUserMessage = cleanMessage(userMessage);

  // Handle forget/clear memory commands before reaching the LLM
  if (isForgetCommand(cleanUserMessage)) {
    const reply = await handleForgetCommand(workspacePath, cleanUserMessage);
    emit?.({ type: "content", content: reply });
    return {
      finalAnswer: reply,
      messages: [new AIMessage(reply)],
    };
  }

  // Handle explicit remember: commands — write to disk synchronously, then confirm
  const rememberMatch = cleanUserMessage.match(/^remember[:\s]+(.+)/is);
  if (rememberMatch) {
    const fact = rememberMatch[1].trim();
    await writeFactDirectly(workspacePath, fact);
    const preview = fact.length > 120 ? `${fact.slice(0, 120)}…` : fact;
    const reply = `Got it, I'll remember: "${preview}"`;
    emit?.({ type: "content", content: reply });
    return {
      finalAnswer: reply,
      messages: [new AIMessage(reply)],
    };
  }

  emit?.({ type: "progress", stage: "answering", message: "💬 Generating response..." });

  // Pre-load memory topics relevant to this question (Claude Code approach)
  const memoryTopics = await loadRelevantTopics(workspacePath, cleanUserMessage);
  const memorySection = buildMemorySection(memoryTopics);
  if (memorySection) {
    const names = Object.keys(memoryTopics).join(", ");
    emit?.({ type: "progress", stage: "memory", message: `🧠 recall: ${names}` });
  }

  const fileSnippet = buildFileContextSnippet(fileContext);

  const userContent = [
    rememberedTargetFile ? `Last file worked on: ${rememberedTargetFile}` : "",
    memorySection ? `Relevant memory from past sessions:\n\n${memorySection}` : "",
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
