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
- Do not mention inability to edit files here; if the user actually wants files changed, the agent pipeline handles it in a separate mode.

ESCALATION (important)
- You can only talk — you cannot edit files, create files, run commands, or install anything.
- If actually fulfilling the user's request would require any of those workspace actions, do NOT try to answer or describe the change. Reply with EXACTLY this token and nothing else: __ESCALATE__
- The system will then hand the request to the agent that can do the work — so escalate instead of explaining what you "would" change.
- Only escalate for real work. Explanations, advice, questions, and read-only discussion about their code are yours to answer — never escalate those.`;

// Sentinel the answer LLM emits when a request actually needs workspace tools.
// The node suppresses it from the stream and routes to agent_loop instead.
const ESCALATE_SENTINEL = "__ESCALATE__";

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

  const escalate = () => {
    console.log("[Answer] escalating to agent_loop — request needs workspace tools");
    emit?.({ type: "progress", stage: "routed", message: "🤖 This needs workspace changes — switching to agent..." });
    // No finalAnswer, no AIMessage: the agent_loop node produces the real
    // output. `escalate` flips the conditional edge in kodo_graph.mjs.
    return { escalate: true };
  };

  try {
    const canStream = typeof streamLLM === "function";

    if (canStream) {
      // Buffered-prefix guard: hold emission until we have enough characters
      // to rule out the escalation sentinel, so "__ESCALATE__" never streams
      // to the user. Once the head is proven non-sentinel, flush + stream live.
      let head = "";        // buffered leading chars, pre-decision
      let gateOpen = false; // true once we've decided it's a real answer
      let escalated = false;
      let full = "";        // complete answer text (post-gate)

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
          if (escalated) return; // discard trailing tokens after an escalate decision
          if (gateOpen) {
            full += chunk;
            emit?.({ type: "content", content: chunk });
            return;
          }
          head += chunk;
          const trimmed = head.trimStart();
          // Still ambiguous — the head could still grow into the sentinel.
          if (trimmed.length < ESCALATE_SENTINEL.length &&
              ESCALATE_SENTINEL.startsWith(trimmed)) {
            return;
          }
          // Enough signal to decide.
          if (trimmed.startsWith(ESCALATE_SENTINEL)) {
            escalated = true;
            return;
          }
          gateOpen = true;
          full = head;
          emit?.({ type: "content", content: head });
        },
      });

      // Stream ended while still buffering a short answer that never tripped
      // the gate (e.g. a one-word reply shorter than the sentinel).
      if (!gateOpen && !escalated) {
        const trimmed = head.trimStart();
        if (trimmed.startsWith(ESCALATE_SENTINEL)) {
          escalated = true;
        } else if (head) {
          full = head;
          emit?.({ type: "content", content: head });
        }
      }

      if (escalated) return escalate();

      return {
        finalAnswer: full,
        messages: [new AIMessage(full)],
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

    const raw = result?.content?.trim() || "";
    if (raw.startsWith(ESCALATE_SENTINEL)) return escalate();

    const finalAnswer = raw || "I couldn't generate a response.";
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
