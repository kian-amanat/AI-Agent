/**
 * answer.mjs
 * Handles non-editing intent: greetings, questions, explanations,
 * code advice, debugging help, and casual conversation.
 *
 * Memory integration (Claude Code approach):
 *  - MEMORY.md index is already in userMessage (injected by plannerAgent)
 *  - Before answering: pre-load full content of relevant topic files
 *  - "forget/clear memory" commands are handled here without hitting the LLM
 *
 * Web research (Claude Code approach):
 *  - The model has web_search + fetch_url as tools and decides when to use
 *    them (e.g. the user references a URL or asks about current external info).
 *    It runs a small tool loop, then streams the final text answer.
 *  - Requests that need workspace tools (edits/commands) still escalate to
 *    agent_loop via the __ESCALATE__ sentinel.
 */

import { AIMessage } from "@langchain/core/messages";
import { chatWithTools } from "../../services/agentChat.mjs";
import { WEB_TOOLS, webSearch, fetchUrl, resolveCreds, looksTimeSensitive, WEB_SEARCH_DIRECTIVE } from "./agent_loop.mjs";
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
- Search the web and read web pages when you need external or current information.

WEB SEARCH (you have web_search(query) and fetch_url(url))
- ALWAYS web_search first — do NOT answer from memory — when the question is about anything time-sensitive or that changes over time, even if you think you already know the answer. Your training data is stale, so a confident-sounding answer is often WRONG. This includes: the "latest/newest/current/last/recent" version, release, price, score, winner, standings, ranking, weather, news, or event; anything with "today/now/this year/as of"; who currently holds a role or title; or any fact tied to a date after your training cutoff. When in doubt about freshness, search.
- Also search when the user shares a URL to read/summarize, or asks about a library/API/error you're unsure of.
- Flow: web_search to find sources, then fetch_url the most relevant result to read the actual page (search snippets can be stale — prefer fetching the real page for numbers/dates/results). If the user already gave a URL, fetch_url it directly.
- Do NOT search for questions about the user's own codebase, stable general concepts, or simple chit-chat — answer those directly.
- After gathering what you need, answer in plain text grounded in what you found, and cite the source URL.

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
  const { userMessage, messages, modelRoute, emit, fileContext, workspacePath, rememberedTargetFile, abortSignal = null } = state;

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
    // Weak models answer stale facts from memory instead of searching — a
    // forceful per-request directive gets far better compliance than the
    // system prompt alone.
    looksTimeSensitive(cleanUserMessage) ? WEB_SEARCH_DIRECTIVE : "",
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
    const creds = await resolveCreds(modelRoute);

    // Tool-capable conversational loop: the model may call web_search /
    // fetch_url when it decides it needs external info, then streams a normal
    // text answer. Text from tool-using turns is shown live as narration but
    // only the FINAL (no-tool) turn is saved as the answer.
    const conversation = [
      ...historyMessages,
      { role: "user", content: userContent },
    ];

    const MAX_TURNS = 5;
    let answerText = "";
    let escalated = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (abortSignal?.aborted) break;

      // Per-turn buffered-prefix guard so the "__ESCALATE__" sentinel never
      // streams to the user (holds only the first ~12 chars back).
      let head = "";
      let gateOpen = false;
      let turnEscalated = false;
      let turnText = "";
      const onChunk = (chunk) => {
        if (turnEscalated) return;
        if (gateOpen) { turnText += chunk; emit?.({ type: "content", content: chunk }); return; }
        head += chunk;
        const trimmed = head.trimStart();
        if (trimmed.length < ESCALATE_SENTINEL.length && ESCALATE_SENTINEL.startsWith(trimmed)) return;
        if (trimmed.startsWith(ESCALATE_SENTINEL)) { turnEscalated = true; return; }
        gateOpen = true; turnText = head; emit?.({ type: "content", content: head });
      };

      const { message } = await chatWithTools({
        creds,
        system: SYSTEM_PROMPT,
        messages: conversation,
        tools: WEB_TOOLS,
        maxTokens: 1400,
        temperature: 0.35,
        signal: abortSignal || undefined,
        onChunk,
      });

      // Flush a short buffered head that never opened the gate.
      if (!gateOpen && !turnEscalated && head) {
        const trimmed = head.trimStart();
        if (trimmed.startsWith(ESCALATE_SENTINEL)) turnEscalated = true;
        else { turnText = head; emit?.({ type: "content", content: head }); }
      }

      if (turnEscalated) { escalated = true; break; }

      conversation.push(message);

      // The model asked to search / fetch — run the tools, feed results back,
      // and loop for the model to answer with what it found.
      if (message.tool_calls?.length) {
        for (const tc of message.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          let result;
          if (tc.function.name === "web_search") {
            emit?.({ type: "progress", stage: "exploring", message: `🔍 web search: "${String(args.query || "").slice(0, 60)}"` });
            result = await webSearch(args.query);
          } else if (tc.function.name === "fetch_url") {
            emit?.({ type: "progress", stage: "exploring", message: `🌐 reading ${String(args.url || "").slice(0, 70)}` });
            result = await fetchUrl(args.url);
          } else {
            result = { success: false, error: `Unknown tool: ${tc.function.name}` };
          }
          const raw = JSON.stringify(result);
          conversation.push({ role: "tool", tool_call_id: tc.id, content: raw.length > 8000 ? raw.slice(0, 8000) + '..."[truncated]"}' : raw });
        }
        continue;
      }

      // Plain text turn = the final answer.
      answerText = turnText;
      break;
    }

    if (escalated) return escalate();

    const finalAnswer = answerText.trim() || "I couldn't generate a response.";
    if (!answerText.trim()) emit?.({ type: "content", content: finalAnswer });

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
