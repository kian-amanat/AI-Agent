"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { v4 as uuidv4 } from "uuid";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles, Bot, Copy, Check, UserIcon } from "lucide-react";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import { useAgentPipeline } from "./hooks/useAgentPipeline";
import { useThinkingSteps } from "./hooks/useThinkingSteps";

import {
  fetchSessions,
  fetchSessionMessages,
  deleteSession,
  sendMessage,
  callUndo,
  type Session,
  type Message as ApiMessage,
  type SSEEvent,
  type UndoResult,
} from "./lib/api";
import AuthGuard from "./components/AuthGuard";

import type { Conversation, Message } from "./components/chat/chat-types";
import { AGENT_STAGES } from "./components/chat/chat-types";

import ChatSidebar from "./components/chat/ChatSidebar";
import ChatHeader from "./components/chat/ChatHeader";
import AgentPipelinePanel from "./components/chat/AgentPipelinePanel";
import ThinkingTrace from "./components/chat/ThinkingTrace";
import AssistantMessage from "./components/chat/AssistantMessage";
import TypingIndicator from "./components/chat/TypingIndicator";
import EmptyStateCard from "./components/chat/EmptyStateCard";
import ChatComposer from "./components/chat/ChatComposer";

const nowIso = () => new Date().toISOString();

type MessageUndoResult = UndoResult | { error: string };

function toUiMessage(message: ApiMessage): Message {
  return {
    id: message.id != null ? String(message.id) : crypto.randomUUID(),
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : String(message.content ?? ""),
    createdAt: message.created_at,
    metadata: {
      intent: message.intent ?? undefined,
      requestId: (message as any).requestId ?? undefined,
      undoResult:
        ((message as any).undoResult as MessageUndoResult | undefined) ?? undefined,
      planMetadata: (message as any).planMetadata ?? undefined,
    },
  };
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";

  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "Now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d`;

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function getPreviewFromMessages(messages: Message[], fallback: string) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content?.trim();
    if (content) {
      return content.length > 54 ? `${content.slice(0, 54)}…` : content;
    }
  }

  return fallback;
}

export default function MinimalChatComponent() {
  const [messageInput, setMessageInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionMessagesCache, setSessionMessagesCache] = useState<
    Record<string, Message[]>
  >({});
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const pipeline = useAgentPipeline();
  const thinking = useThinkingSteps();

  const [loadingSessions, setLoadingSessions] = useState(false);
  const [undoingMessageId, setUndoingMessageId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRequestRef = useRef<null | (() => void)>(null);
  const messagesRef = useRef<Message[]>([]);
  const selectedSessionIdRef = useRef<string | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  function scrollToBottomSoon() {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }

  useEffect(() => {
    scrollToBottomSoon();
  }, [messages]);



  async function refreshSessions(preferredSessionId?: string | null) {
    try {
      const data = await fetchSessions();
      setSessions(data);

      if (preferredSessionId && data.some((session) => session.id === preferredSessionId)) {
        setSelectedSessionId(preferredSessionId);
      }

      return data;
    } catch (error) {
      console.error("Failed to refresh sessions:", error);
      return [];
    }
  }

  async function openSession(sessionId: string) {
    setSelectedSessionId(sessionId);
    setSelectedFiles([]);
    setMessageInput("");
    setIsRecording(false);

    router.replace(`/?session=${encodeURIComponent(sessionId)}`, { scroll: false });

    const cached = sessionMessagesCache[sessionId];
    if (cached?.length) {
      setMessages(cached);
    } else {
      setMessages([]);
    }

    try {
      const apiMessages = await fetchSessionMessages(sessionId);
      const uiMessages = apiMessages.map(toUiMessage);
      setSessionMessagesCache((prev) => ({ ...prev, [sessionId]: uiMessages }));
      setMessages(uiMessages);
    } catch (error) {
      console.error("Failed to load session messages:", error);
      if (!cached?.length) setMessages([]);
    }
  }

  useEffect(() => {
    let isMounted = true;

    async function loadSessionsAndMaybeOpen() {
      setLoadingSessions(true);
      try {
        const data = await fetchSessions();
        if (!isMounted) return;

        setSessions(data);

        const urlSessionId = searchParams.get("session");

        if (urlSessionId && data.some((s) => s.id === urlSessionId)) {
          await openSession(urlSessionId);
        } else if (data.length > 0 && !selectedSessionIdRef.current) {
          await openSession(data[0].id);
        }
      } catch (error) {
        console.error("Failed to load sessions:", error);
      } finally {
        if (isMounted) setLoadingSessions(false);
      }
    }

    void loadSessionsAndMaybeOpen();

    return () => {
      isMounted = false;
      abortRequestRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeleteSession(sessionId: string) {
    const ok = window.confirm("Delete this conversation?");
    if (!ok) return;

    try {
      await deleteSession(sessionId);

      const nextSessions = sessions.filter((s) => s.id !== sessionId);
      setSessions(nextSessions);

      setSessionMessagesCache((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });

      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
        setSelectedFiles([]);
        setMessages([]);
        setMessageInput("");

        if (nextSessions.length > 0) {
          await openSession(nextSessions[0].id);
        } else {
          router.replace("/", { scroll: false });
        }
      }
    } catch (error) {
      console.error("Failed to delete session:", error);
    }
  }

  async function copyToClipboard(text: string, messageId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 1600);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }

  function startNewChat() {
    abortRequestRef.current?.();
    abortRequestRef.current = null;
    setSelectedSessionId(null);
    setSelectedFiles([]);
    setMessages([]);
    setMessageInput("");
    setIsRecording(false);
    router.replace("/", { scroll: false });
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  function applyUndoResultToMessage(
    list: Message[],
    messageId: string,
    undoResult: MessageUndoResult
  ) {
    return list.map((message) =>
      message.id === messageId
        ? {
            ...message,
            metadata: {
              ...(message.metadata || {}),
              undoResult,
            },
          }
        : message
    );
  }

  async function handleUndoClick(messageId: string) {
    const target = messagesRef.current.find((message) => message.id === messageId);
    const sessionId = selectedSessionIdRef.current;
    const requestId = target?.metadata?.requestId;

    if (!target || !requestId || !sessionId) {
      console.warn("Undo skipped: missing target, sessionId, or requestId");
      return;
    }

    try {
      setUndoingMessageId(messageId);

      const result: UndoResult = await callUndo(sessionId, requestId);

      setMessages((prev) => applyUndoResultToMessage(prev, messageId, result));
      setSessionMessagesCache((prevCache) => ({
        ...prevCache,
        [sessionId]: applyUndoResultToMessage(
          prevCache[sessionId] ?? [],
          messageId,
          result
        ),
      }));
    } catch (error) {
      console.error("Undo failed", error);

      const undoError: MessageUndoResult = {
        error: error instanceof Error ? error.message : String(error ?? "Undo failed"),
      };

      setMessages((prev) => applyUndoResultToMessage(prev, messageId, undoError));
      setSessionMessagesCache((prevCache) => ({
        ...prevCache,
        [sessionId]: applyUndoResultToMessage(
          prevCache[sessionId] ?? [],
          messageId,
          undoError
        ),
      }));
    } finally {
      setUndoingMessageId(null);
    }
  }

  async function handleSendMessage() {
    const text = messageInput.trim();
    if ((!text && selectedFiles.length === 0) || isSending) return;

    setIsSending(true);
    pipeline.start();

    const fileNames = selectedFiles.map((file) => file.name).join(", ");

    const userMessage: Message = {
      id: uuidv4(),
      role: "user",
      content:
        text ||
        (selectedFiles.length > 0
          ? `Uploaded file${selectedFiles.length > 1 ? "s" : ""}: ${fileNames}`
          : "attachment"),
      createdAt: nowIso(),
    };

    const assistantMessageId = uuidv4();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      metadata: undefined,
    };

    // Begin a thinking trace for this assistant message
    thinking.begin(assistantMessageId);

    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    setMessages(nextMessages);

    if (selectedSessionIdRef.current) {
      setSessionMessagesCache((prev) => ({
        ...prev,
        [selectedSessionIdRef.current as string]: nextMessages,
      }));
      setSessions((prev) =>
        prev.map((session) =>
          session.id === selectedSessionIdRef.current
            ? {
                ...session,
                updated_at: nowIso(),
              }
            : session
        )
      );
    }

    setMessageInput("");
    setSelectedFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const cleanup = sendMessage(
      text,
      selectedFiles.length > 0 ? selectedFiles : null,
      selectedSessionIdRef.current,
      (event: SSEEvent) => {
        pipeline.onSSEEvent(event);
        thinking.onSSEEvent(assistantMessageId, event);

        if (event.type === "content") {
          setMessages((prev) => {
            const updated = prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: msg.content + event.chunk }
                : msg
            );

            const activeSessionId = selectedSessionIdRef.current;
            if (activeSessionId) {
              setSessionMessagesCache((prevCache) => ({
                ...prevCache,
                [activeSessionId]: updated,
              }));
            }

            return updated;
          });
          return;
        }

        if (event.type === "start") {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    metadata: {
                      ...(msg.metadata || {}),
                      intent: event.intent ?? msg.metadata?.intent,
                      requestId: event.requestId ?? msg.metadata?.requestId,
                    },
                  }
                : msg
            )
          );
          return;
        }

        if (event.type === "done") {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    metadata: {
                      ...(msg.metadata || {}),
                      requestId: event.requestId ?? msg.metadata?.requestId,
                    },
                  }
                : msg
            )
          );
          return;
        }

        if (event.type === "plan_metadata") {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    metadata: {
                      ...(msg.metadata || {}),
                      planMetadata: event.raw,
                    },
                  }
                : msg
            )
          );
          return;
        }
      },
      (returnedSessionId, requestId) => {
        const finalSessionId = returnedSessionId || selectedSessionIdRef.current;

        if (finalSessionId) {
          setSelectedSessionId(finalSessionId);
          setSessionMessagesCache((prev) => ({
            ...prev,
            [finalSessionId]: messagesRef.current,
          }));
          void refreshSessions(finalSessionId);
          router.replace(`/?session=${encodeURIComponent(finalSessionId)}`, {
            scroll: false,
          });
        }

        if (requestId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    metadata: {
                      ...(m.metadata || {}),
                      requestId,
                    },
                  }
                : m
            )
          );
        }

        // Close the thinking trace for this message
        thinking.end(assistantMessageId);
        pipeline.stop();

        setIsSending(false);
        abortRequestRef.current = null;
      },
      (err) => {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  content: "خطا در اتصال به backend:\n" + err,
                }
              : msg
          )
        );

        thinking.end(assistantMessageId);
        pipeline.stop();

        setIsSending(false);
        abortRequestRef.current = null;
      }
    );

    abortRequestRef.current = cleanup;
  }

  function handleMessageKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  }

  const filteredConversations = useMemo(() => {
    const q = conversationSearch.trim().toLowerCase();

    const data: Conversation[] = sessions.map((session) => {
      const cachedMessages = sessionMessagesCache[session.id] || [];
      const preview = getPreviewFromMessages(
        cachedMessages,
        session.message_count > 0
          ? `${session.message_count} message${session.message_count === 1 ? "" : "s"}`
          : "No messages yet"
      );

      return {
        id: session.id,
        title: session.title?.trim() || "Untitled conversation",
        preview,
        updatedAt: formatUpdatedAt(session.updated_at),
        unread: 0,
      };
    });

    if (!q) return data;

    return data.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(q) ||
        conversation.preview.toLowerCase().includes(q)
    );
  }, [conversationSearch, sessions, sessionMessagesCache]);

  const isEmpty = messages.length === 0;

  const quickPrompts = [
    { title: "Show the agent pipeline", desc: "Make the current stage visible in chat." },
    { title: "Use orange-red accents", desc: "Highlight important actions and progress." },
    { title: "Add brilliant transitions", desc: "Make messages and inputs feel premium." },
    { title: "Keep it minimal", desc: "Thin borders, calm surfaces, modern spacing." },
  ];

  return (
    <AuthGuard>
    <div className="flex h-screen w-full overflow-hidden bg-[#161616] text-white">
      <ChatSidebar
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed((p) => !p)}
        onStartNewChat={startNewChat}
        conversationSearch={conversationSearch}
        setConversationSearch={setConversationSearch}
        filteredConversations={filteredConversations}
        selectedSessionId={selectedSessionId}
        onOpenSession={openSession}
        onDeleteSession={handleDeleteSession}
        loadingSessions={loadingSessions}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <ChatHeader onToggleSidebar={() => setIsSidebarCollapsed((p) => !p)} />

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8"
          >
            <div className="mx-auto flex w-full max-w-4xl flex-col">
              <AnimatePresence mode="wait">
                {isEmpty ? (
                  <motion.div
                    key="empty"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -12 }}
                    transition={{ duration: 0.35, ease: "easeOut" }}
                    className="flex min-h-[calc(100vh-12rem)] flex-col items-center justify-center pb-16"
                  >
                    <motion.div
                      initial={{ scale: 0.92, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 260, damping: 22 }}
                      className="mb-6 flex h-16 w-16 items-center justify-center rounded-[28px] border border-white/8 bg-white/[0.04]"
                    >
                      <Sparkles className="h-7 w-7 text-white/85" />
                    </motion.div>

                    <h1 className="text-center text-3xl font-normal tracking-[-0.03em] text-white md:text-5xl">
                      What&apos;s on the agenda today?
                    </h1>

                    <p className="mt-4 max-w-2xl text-center text-sm leading-6 text-white/38 md:text-base">
                      A cleaner chat surface with a visible agent pipeline, orange-red accents, and smoother motion.
                    </p>

                    <div className="mt-10 grid w-full max-w-4xl grid-cols-1 gap-3 md:grid-cols-2">
                      {quickPrompts.map((item) => (
                        <EmptyStateCard
                          key={item.title}
                          title={item.title}
                          desc={item.desc}
                          onClick={() => setMessageInput(item.title)}
                        />
                      ))}
                    </div>
                  </motion.div>
                ) : (
                  <motion.div layout className="space-y-5 pb-8">
                    <AnimatePresence initial={false}>
                      {messages.map((m) => {
                        const trace = thinking.getTrace(m.id);
                        const showTrace =
                          m.role === "assistant" &&
                          (trace.steps.length > 0 || trace.isActive);

                        return (
 <motion.div
  key={m.id}
  layout
  initial={{ opacity: 0, y: 14, scale: 0.985 }}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  exit={{ opacity: 0, y: -8, scale: 0.99 }}
  transition={{ type: "spring", stiffness: 240, damping: 24 }}
  className={`flex w-full ${
    m.role === "user" ? "justify-end" : "justify-start"
  }`}
>
  <div className="group max-w-[min(92%,48rem)]">
    {m.role === "user" ? (
      <div className="rounded-[24px] border border-[#ff8a3d]/18 bg-gradient-to-br from-[#ff8a3d]/10 via-[#ff5e4d]/8 to-[#ff2d2d]/6 px-4 py-3.5 shadow-sm md:px-5 md:py-4 text-white">
        <div className="mb-2 flex items-center gap-2 text-xs text-white/32">
          <UserIcon className="h-4 w-4 text-[#ff8a3d]" />
          <span>You</span>
        </div>

        <div className="whitespace-pre-wrap text-[15px] leading-7 text-white/92">
          {m.content}
        </div>
      </div>
    ) : (
      <div className="px-0 py-0 text-white">
        <div className="mb-2 flex items-center gap-2 text-xs text-white/30">
          <Bot className="h-4 w-4 text-[#ff8a3d]" />
          <span>Assistant</span>
        </div>

{showTrace && (
  <div className="mb-4">
    <ThinkingTrace
      steps={trace.steps}
      isActive={trace.isActive}
      startedAt={trace.startedAt}
    />
  </div>
)}

        {m.content ? (
          <AssistantMessage
            content={m.content}
            metadata={m.metadata}
            onUndoClick={
              m.metadata?.requestId
                ? () => handleUndoClick(m.id)
                : undefined
            }
            isUndoing={undoingMessageId === m.id}
          />
        ) : !trace.isActive ? (
          <div className="flex items-center gap-2 text-white/40">
            <TypingIndicator />
            <span className="text-sm">Running agent…</span>
          </div>
        ) : null}
      </div>
    )}

    {m.role === "assistant" && m.content && (
      <div className="mt-2 flex items-center gap-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={() => copyToClipboard(m.content, m.id)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 transition-colors duration-200 hover:border-[#ff8a3d]/20 hover:bg-[#ff8a3d]/8 hover:text-white"
        >
          {copiedMessageId === m.id ? (
            <>
              <Check className="h-3.5 w-3.5 text-[#ff8a3d]" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={scrollToBottomSoon}
          title="Scroll to latest"
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 transition-colors duration-200 hover:border-[#ff8a3d]/20 hover:bg-[#ff8a3d]/8 hover:text-white"
        >
          <KeyboardArrowDownRoundedIcon style={{ fontSize: 14 }} />
          Latest
        </motion.button>
      </div>
    )}

    <div className="mt-1.5 px-1 text-[11px] text-white/24">
      {new Date(m.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </div>
  </div>
</motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <ChatComposer
            messageInput={messageInput}
            setMessageInput={setMessageInput}
            textareaRef={textareaRef}
            isInputFocused={isInputFocused}
            setIsInputFocused={setIsInputFocused}
            isSending={isSending}
            isRecording={isRecording}
            setIsRecording={setIsRecording}
            onSendMessage={handleSendMessage}
            onMessageKeyDown={handleMessageKeyDown}
            selectedFiles={selectedFiles}
            setSelectedFiles={setSelectedFiles}
          />
        </div>
      </section>
    </div>
    </AuthGuard>
  );
}
