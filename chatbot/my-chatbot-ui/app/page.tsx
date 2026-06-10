"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { v4 as uuidv4 } from "uuid";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles, Bot, Copy, Check, UserIcon } from "lucide-react";
import {
  fetchSessions,
  fetchSessionMessages,
  deleteSession,
  sendMessage,
  type Session,
  type Message as ApiMessage,
  type SSEEvent,
} from "./lib/api";

import type { Conversation, Message } from "./components/chat/chat-types";
import { AGENT_STAGES } from "./components/chat/chat-types";

import ChatSidebar from "./components/chat/ChatSidebar";
import ChatHeader from "./components/chat/ChatHeader";
import AgentPipelinePanel from "./components/chat/AgentPipelinePanel";
import AssistantMessage from "./components/chat/AssistantMessage";
import TypingIndicator from "./components/chat/TypingIndicator";
import EmptyStateCard from "./components/chat/EmptyStateCard";
import ChatComposer from "./components/chat/ChatComposer";

const nowIso = () => new Date().toISOString();

function toUiMessage(message: ApiMessage): Message {
  return {
    id: message.id != null ? String(message.id) : crypto.randomUUID(),
    role: message.role,
    content: typeof message.content === "string" ? message.content : String(message.content ?? ""),
    createdAt: message.created_at,
    metadata: {
      intent: message.intent ?? undefined,
      // این دو فیلد به‌صورت رسمی در ApiMessage نیستند،
      // ولی اگر بک‌اند اضافه‌شان کند، اینجا می‌گیریم:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestId: (message as any).requestId ?? undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undoResult: (message as any).undoResult ?? undefined,
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTask, setActiveTask] = useState("");
  const [pipelineStage, setPipelineStage] = useState(0);
  const [pipelineProgress, setPipelineProgress] = useState(0);

  const [loadingSessions, setLoadingSessions] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRequestRef = useRef<null | (() => void)>(null);
  const messagesRef = useRef<Message[]>([]);
  const selectedSessionIdRef = useRef<string | null>(null);

  // state مربوط به Undo
  const [undoingMessageId, setUndoingMessageId] = useState<string | null>(null);

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

  useEffect(() => {
    if (!isProcessing) return;

    const progressMap = [12, 28, 48, 72, 90];
    const timer = window.setInterval(() => {
      setPipelineStage((prev) => {
        const next = Math.min(prev + 1, AGENT_STAGES.length - 1);
        const nextProgress = progressMap[next] ?? 95;
        setPipelineProgress(nextProgress);
        return next;
      });
    }, 1150);

    return () => window.clearInterval(timer);
  }, [isProcessing]);

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
    setSelectedFile(null);

    router.push(`/?session=${sessionId}`, { scroll: false });

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
        setSelectedFile(null);
        setMessages([]);
        setMessageInput("");

        if (nextSessions.length > 0) {
          void openSession(nextSessions[0].id);
        } else {
          router.push("/", { scroll: false });
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
    setSelectedFile(null);
    setMessages([]);
    setMessageInput("");
    router.push("/", { scroll: false });
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function handleUndoClick(messageId: string) {
    const target = messagesRef.current.find((m) => m.id === messageId);
    if (!target?.metadata?.requestId) return;

    try {
      setUndoingMessageId(messageId);

      // TODO: در مرحله بعدی این را به callUndo(...) وصل کن
      const fakeUndoResult = {
        status: "success",
        restoredFiles: ["src/app/page.tsx"],
        deletedFiles: [],
        failedFiles: [],
      };

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                metadata: {
                  ...(m.metadata || {}),
                  undoResult: fakeUndoResult,
                },
              }
            : m
        )
      );
    } catch (e) {
      console.error("Undo failed", e);
    } finally {
      setUndoingMessageId(null);
    }
  }

  async function handleSendMessage() {
    const text = messageInput.trim();
    if ((!text && !selectedFile) || isSending) return;

    setIsSending(true);
    setIsProcessing(true);
    setActiveTask(selectedFile ? `Analyzing ${selectedFile.name}` : text);
    setPipelineStage(0);
    setPipelineProgress(10);

    const userMessage: Message = {
      id: uuidv4(),
      role: "user",
      content: text || `Uploaded file: ${selectedFile?.name ?? "attachment"}`,
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
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const cleanup = sendMessage(
      text,
      selectedFile,
      selectedSessionIdRef.current,
      (event: SSEEvent) => {
        if (event.type === "content") {
          // فقط chunk متن را اضافه کن
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
          // intent و requestId اولیه
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
          // requestId نهایی
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

        if (event.type === "progress") {
          // در حال حاضر AgentPipelinePanel مستقل است، اینجا کاری نمی‌کنیم
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

        setSelectedFile(null);
        setPipelineStage(AGENT_STAGES.length - 1);
        setPipelineProgress(100);

        setTimeout(() => {
          setIsProcessing(false);
        }, 500);

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

        setPipelineStage(AGENT_STAGES.length - 1);
        setPipelineProgress(100);
        setTimeout(() => {
          setIsProcessing(false);
        }, 500);

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

      <section className="flex min-w-0 flex-1 flex-col bg-[#161616]">
        <ChatHeader onToggleSidebar={() => setIsSidebarCollapsed((p) => !p)} />

        <div className="flex min-h-0 flex-1 flex-col">
          <AnimatePresence mode="wait">
            {isProcessing && (
              <AgentPipelinePanel
                key="agent-pipeline"
                task={activeTask}
                stageIndex={pipelineStage}
                progress={pipelineProgress}
                stages={AGENT_STAGES}
              />
            )}
          </AnimatePresence>

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
                      {messages.map((m) => (
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
                            <div
                              className={`rounded-[24px] border px-4 py-3.5 shadow-sm transition-all duration-300 md:px-5 md:py-4 ${
                                m.role === "user"
                                  ? "border-[#ff8a3d]/18 bg-gradient-to-br from-[#ff8a3d]/10 via-[#ff5e4d]/8 to-[#ff2d2d]/6 text-white"
                                  : "border-white/8 bg-white/[0.03] text-white"
                              }`}
                            >
                              <div className="mb-2 flex items-center gap-2 text-xs text-white/32">
                                {m.role === "assistant" ? (
                                  <>
                                    <Bot className="h-4 w-4 text-[#ff8a3d]" />
                                    <span>Assistant</span>
                                  </>
                                ) : (
                                  <>
                                    <UserIcon className="h-4 w-4 text-[#ff8a3d]" />
                                    <span>You</span>
                                  </>
                                )}
                              </div>

                              {m.role === "assistant" ? (
                                m.content ? (
                                  <AssistantMessage
                                    content={m.content}
                                    metadata={m.metadata}
                                    onUndoClick={
                                      m.metadata?.intent === "technical" &&
                                      m.metadata?.requestId
                                        ? () => handleUndoClick(m.id)
                                        : undefined
                                    }
                                    isUndoing={undoingMessageId === m.id}
                                  />
                                ) : (
                                  <div className="flex items-center gap-2 text-white/40">
                                    <TypingIndicator />
                                    <span className="text-sm">Running agent…</span>
                                  </div>
                                )
                              ) : (
                                <div className="whitespace-pre-wrap text-[15px] leading-7 text-white/92">
                                  {m.content}
                                </div>
                              )}
                            </div>

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
                      ))}
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
            selectedFile={selectedFile}
            setSelectedFile={setSelectedFile}
          />
        </div>
      </section>
    </div>
  );
}
