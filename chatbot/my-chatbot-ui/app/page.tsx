"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { v4 as uuidv4 } from "uuid";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, Copy, Check, UserIcon } from "lucide-react";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
import { useAgentPipeline } from "./hooks/useAgentPipeline";
import { useThinkingSteps } from "./hooks/useThinkingSteps";

import {
  fetchSessions,
  fetchSessionMessages,
  deleteSession,
  sendMessage,
  callUndo,
  confirmPlan,
  rejectPlan,
  compactConversation,
  type Session,
  type Message as ApiMessage,
  type SSEEvent,
  type UndoResult,
  type PlanStep,
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
import PlanPreviewPanel from "./components/chat/PlanPreviewPanel";
import FileTreeSidebar from "./components/chat/FileTreeSidebar";
import type { SlashCommandId } from "./components/chat/SlashCommandPalette";

const nowIso = () => new Date().toISOString();

type MessageUndoResult = UndoResult | { error: string };
type PermissionMode = "auto" | "ask";

function toUiMessage(message: ApiMessage): Message {
  let fileDiffs: import("./lib/api").FileDiff[] | undefined;
  try {
    const raw = (message as any).file_diffs;
    if (raw) fileDiffs = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { fileDiffs = undefined; }

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
      requestId: (message as any).request_id ?? (message as any).requestId ?? undefined,
      fileDiffs,
      undoResult:
        ((message as any).undoResult as MessageUndoResult | undefined) ?? undefined,
      planMetadata: (message as any).planMetadata ?? undefined,
    },
  };
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));
  const diffHour = Math.floor(diffMin / 60);
  const diffDay  = Math.floor(diffHour / 24);
  if (diffMin < 1)  return "Now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7)   return `${diffDay}d`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getPreviewFromMessages(messages: Message[], fallback: string) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content?.trim();
    if (content) return content.length > 54 ? `${content.slice(0, 54)}…` : content;
  }
  return fallback;
}

export default function MinimalChatComponent() {
  const [messageInput, setMessageInput]   = useState("");
  const [isSending, setIsSending]         = useState(false);
  const [isRecording, setIsRecording]     = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [selectedSessionId, setSelectedSessionId]   = useState<string | null>(null);
  const [messages, setMessages]     = useState<Message[]>([]);
  const [sessions, setSessions]     = useState<Session[]>([]);
  const [sessionMessagesCache, setSessionMessagesCache] = useState<Record<string, Message[]>>({});
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [selectedFiles, setSelectedFiles]   = useState<File[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [undoingMessageId, setUndoingMessageId] = useState<string | null>(null);
  const [undoableRequestId, setUndoableRequestId] = useState<string | null>(null);

  // ── Permission mode (persisted to localStorage) ──────────────
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    if (typeof window === "undefined") return "auto";
    return (localStorage.getItem("kodo_permission_mode") as PermissionMode) ?? "auto";
  });

  // ── Plan preview (for "ask" permission mode) ─────────────────
  const [pendingPlan, setPendingPlan] = useState<{
    steps:            PlanStep[];
    assistantMsgId:   string;
    requestId:        string;
    isApproving:      boolean;
  } | null>(null);

  // ── File tree sidebar ─────────────────────────────────────────
  const [fileTreeOpen, setFileTreeOpen] = useState(false);

  const pipeline = useAgentPipeline();
  const thinking = useThinkingSteps();

  const scrollRef    = useRef<HTMLDivElement | null>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  const abortRequestRef    = useRef<null | (() => void)>(null);
  const messagesRef  = useRef<Message[]>([]);
  const selectedSessionIdRef = useRef<string | null>(null);

  const router       = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { selectedSessionIdRef.current = selectedSessionId; }, [selectedSessionId]);

  function scrollToBottomSoon() {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }
  useEffect(() => { scrollToBottomSoon(); }, [messages]);

  async function refreshSessions(preferredSessionId?: string | null) {
    try {
      const data = await fetchSessions();
      setSessions(data);
      if (preferredSessionId && data.some((s) => s.id === preferredSessionId))
        setSelectedSessionId(preferredSessionId);
      return data;
    } catch {
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
    if (cached?.length) setMessages(cached);
    else setMessages([]);

    try {
      const apiMessages = await fetchSessionMessages(sessionId);
      const uiMessages  = apiMessages.map(toUiMessage);
      setSessionMessagesCache((prev) => ({ ...prev, [sessionId]: uiMessages }));
      setMessages(uiMessages);
      const lastChanges = [...uiMessages].reverse().find(
        (m) => m.role === "assistant" && m.metadata?.requestId && m.metadata?.fileDiffs?.length,
      );
      setUndoableRequestId(lastChanges?.metadata?.requestId ?? null);
    } catch {
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
      } catch {}
      finally { if (isMounted) setLoadingSessions(false); }
    }
    void loadSessionsAndMaybeOpen();
    return () => { isMounted = false; abortRequestRef.current?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeleteSession(sessionId: string) {
    if (!window.confirm("Delete this conversation?")) return;
    try {
      await deleteSession(sessionId);
      const nextSessions = sessions.filter((s) => s.id !== sessionId);
      setSessions(nextSessions);
      setSessionMessagesCache((prev) => { const n = { ...prev }; delete n[sessionId]; return n; });
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
        setSelectedFiles([]);
        setMessages([]);
        setMessageInput("");
        if (nextSessions.length > 0) await openSession(nextSessions[0].id);
        else router.replace("/", { scroll: false });
      }
    } catch {}
  }

  async function copyToClipboard(text: string, messageId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 1600);
    } catch {}
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

  function handleStop() {
    abortRequestRef.current?.();
    abortRequestRef.current = null;
    setIsSending(false);
  }

  function applyUndoResultToMessage(list: Message[], messageId: string, undoResult: MessageUndoResult) {
    return list.map((m) =>
      m.id === messageId ? { ...m, metadata: { ...(m.metadata || {}), undoResult } } : m
    );
  }

  async function handleUndoClick(messageId: string) {
    const target    = messagesRef.current.find((m) => m.id === messageId);
    const sessionId = selectedSessionIdRef.current;
    const requestId = target?.metadata?.requestId;
    if (!target || !requestId || !sessionId) return;
    try {
      setUndoingMessageId(messageId);
      const result = await callUndo(sessionId, requestId);
      setMessages((prev) => applyUndoResultToMessage(prev, messageId, result));
      setSessionMessagesCache((c) => ({ ...c, [sessionId]: applyUndoResultToMessage(c[sessionId] ?? [], messageId, result) }));
    } catch (error) {
      const undoError: MessageUndoResult = { error: error instanceof Error ? error.message : String(error ?? "Undo failed") };
      setMessages((prev) => applyUndoResultToMessage(prev, messageId, undoError));
      setSessionMessagesCache((c) => ({ ...c, [sessionId]: applyUndoResultToMessage(c[sessionId] ?? [], messageId, undoError) }));
    } finally {
      setUndoingMessageId(null);
    }
  }

  // ── Permission mode toggle ────────────────────────────────────
  function handleTogglePermissionMode() {
    setPermissionMode((prev) => {
      const next = prev === "auto" ? "ask" : "auto";
      localStorage.setItem("kodo_permission_mode", next);
      return next;
    });
  }

  // ── Plan approval handlers ────────────────────────────────────
  async function handleApprovePlan() {
    if (!pendingPlan) return;
    setPendingPlan((p) => p ? { ...p, isApproving: true } : null);
    try {
      await confirmPlan(pendingPlan.requestId);
    } catch (err) {
      console.error("Approve plan failed:", err);
    } finally {
      setPendingPlan(null);
    }
  }

  async function handleRejectPlan() {
    if (!pendingPlan) return;
    try {
      await rejectPlan(pendingPlan.requestId);
    } catch {}
    setPendingPlan(null);
  }

  // ── Compact conversation ──────────────────────────────────────
  async function handleCompact() {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId || isSending) return;
    try {
      const { summary, messageCount } = await compactConversation(sessionId);
      const compactMsg: Message = {
        id:        uuidv4(),
        role:      "assistant",
        content:   summary,
        createdAt: nowIso(),
        metadata:  { intent: "compact" },
      };
      setMessages([compactMsg]);
      setSessionMessagesCache((c) => ({ ...c, [sessionId]: [compactMsg] }));
      console.log(`[Compact] Compressed ${messageCount} messages`);
    } catch (err) {
      console.error("Compact failed:", err);
    }
  }

  // ── Slash command handler ─────────────────────────────────────
  function handleSlashCommand(id: SlashCommandId) {
    switch (id) {
      case "clear":
        setMessages([]);
        if (selectedSessionIdRef.current)
          setSessionMessagesCache((c) => ({ ...c, [selectedSessionIdRef.current!]: [] }));
        break;
      case "compact":
        void handleCompact();
        break;
      case "undo": {
        const lastUndoable = [...messagesRef.current].reverse().find(
          (m) => m.role === "assistant" && m.metadata?.requestId && m.metadata?.fileDiffs?.length,
        );
        if (lastUndoable) void handleUndoClick(lastUndoable.id);
        break;
      }
      case "help":
        setMessages((prev) => [
          ...prev,
          {
            id:        uuidv4(),
            role:      "assistant" as const,
            content:   "**Available slash commands:**\n\n- `/clear` — Clear all messages from the view\n- `/compact` — Summarize and compress the conversation\n- `/undo` — Undo the last set of file changes\n- `/help` — Show this help message",
            createdAt: nowIso(),
          },
        ]);
        break;
    }
  }

  // ── File select from file tree ────────────────────────────────
  function handleFileTreeSelect(path: string) {
    const mention = `@${path} `;
    setMessageInput((prev) => (prev ? `${prev} ${mention}` : mention));
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function handleSendMessage() {
    const text = messageInput.trim();
    if ((!text && selectedFiles.length === 0) || isSending) return;

    setIsSending(true);
    setUndoableRequestId(null);
    pipeline.start();

    const fileNames = selectedFiles.map((f) => f.name).join(", ");
    const userMessage: Message = {
      id:        uuidv4(),
      role:      "user",
      content:   text || (selectedFiles.length > 0 ? `Uploaded file${selectedFiles.length > 1 ? "s" : ""}: ${fileNames}` : "attachment"),
      createdAt: nowIso(),
    };

    const assistantMessageId = uuidv4();
    const assistantMessage: Message = {
      id:        assistantMessageId,
      role:      "assistant",
      content:   "",
      createdAt: nowIso(),
      metadata:  undefined,
    };

    thinking.begin(assistantMessageId);

    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    setMessages(nextMessages);

    if (selectedSessionIdRef.current) {
      setSessionMessagesCache((prev) => ({
        ...prev,
        [selectedSessionIdRef.current as string]: nextMessages,
      }));
      setSessions((prev) =>
        prev.map((s) => s.id === selectedSessionIdRef.current ? { ...s, updated_at: nowIso() } : s)
      );
    }

    setMessageInput("");
    setSelectedFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    let fileDiffsReceived = false;

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
              msg.id === assistantMessageId ? { ...msg, content: msg.content + event.chunk } : msg
            );
            const sid = selectedSessionIdRef.current;
            if (sid) setSessionMessagesCache((c) => ({ ...c, [sid]: updated }));
            return updated;
          });
          return;
        }

        if (event.type === "start") {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, metadata: { ...(msg.metadata || {}), intent: event.intent ?? msg.metadata?.intent, requestId: event.requestId ?? msg.metadata?.requestId } }
                : msg
            )
          );
          return;
        }

        if (event.type === "done") {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, metadata: { ...(msg.metadata || {}), requestId: event.requestId ?? msg.metadata?.requestId } }
                : msg
            )
          );
          return;
        }

        if (event.type === "plan_metadata") {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, metadata: { ...(msg.metadata || {}), planMetadata: event.raw } }
                : msg
            )
          );
          return;
        }

        // ── Plan preview (ask mode) ───────────────────────────
        if (event.type === "plan_preview") {
          const rid = messagesRef.current.find((m) => m.id === assistantMessageId)?.metadata?.requestId;
          if (rid) {
            setPendingPlan({ steps: event.steps, assistantMsgId: assistantMessageId, requestId: rid, isApproving: false });
          }
          return;
        }

        if (event.type === "file_diff") {
          fileDiffsReceived = true;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    metadata: {
                      ...(msg.metadata || {}),
                      fileDiffs: [
                        ...(msg.metadata?.fileDiffs || []),
                        { action: event.action, path: event.path, language: event.language, hunks: event.hunks },
                      ],
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
          setSessionMessagesCache((prev) => ({ ...prev, [finalSessionId]: messagesRef.current }));
          void refreshSessions(finalSessionId);
          router.replace(`/?session=${encodeURIComponent(finalSessionId)}`, { scroll: false });
        }
        if (requestId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, metadata: { ...(m.metadata || {}), requestId } }
                : m
            )
          );
        }
        if (requestId && fileDiffsReceived) setUndoableRequestId(requestId);
        setPendingPlan(null);
        thinking.end(assistantMessageId);
        pipeline.stop();
        setIsSending(false);
        abortRequestRef.current = null;
      },
      (err) => {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId ? { ...msg, content: "Error connecting to backend:\n" + err } : msg
          )
        );
        setPendingPlan(null);
        thinking.end(assistantMessageId);
        pipeline.stop();
        setIsSending(false);
        abortRequestRef.current = null;
      },
      undefined,
      permissionMode,
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
        session.message_count > 0 ? `${session.message_count} message${session.message_count === 1 ? "" : "s"}` : "No messages yet"
      );
      return {
        id:        session.id,
        title:     session.title?.trim() || "Untitled conversation",
        preview,
        updatedAt: formatUpdatedAt(session.updated_at),
        unread:    0,
      };
    });
    if (!q) return data;
    return data.filter((c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q));
  }, [conversationSearch, sessions, sessionMessagesCache]);

  const isEmpty = messages.length === 0;
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => setShowScrollButton(el.scrollHeight - el.scrollTop - el.clientHeight > 150);
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

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

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ChatHeader
            onToggleSidebar={() => setIsSidebarCollapsed((p) => !p)}
            permissionMode={permissionMode}
            onTogglePermissionMode={handleTogglePermissionMode}
            onCompact={handleCompact}
            onToggleFileTree={() => setFileTreeOpen((p) => !p)}
            fileTreeOpen={fileTreeOpen}
            isSending={isSending}
          />

          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* Main chat area */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div
                ref={scrollRef}
                className="relative min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8"
              >
                {showScrollButton && (
                  <button
                    type="button"
                    onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
                    className="absolute bottom-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-[#ff8a3d] text-white shadow-lg transition-transform hover:scale-105 hover:bg-[#e67a35]"
                    aria-label="Scroll to bottom"
                  >
                    <KeyboardArrowDownRoundedIcon fontSize="small" />
                  </button>
                )}

                <div className="mx-auto flex w-full max-w-4xl flex-col">
                  <AnimatePresence mode="wait">
                    {isEmpty ? (
                      <motion.div
                        key="empty"
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="flex min-h-[calc(100vh-12rem)] w-full items-center justify-center"
                      >
                        <EmptyStateCard
                          onSuggestion={(text) => {
                            setMessageInput(text);
                            setTimeout(() => {
                              const el = textareaRef.current;
                              if (!el) return;
                              el.focus();
                              el.style.height = "auto";
                              el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
                            }, 40);
                          }}
                        />
                      </motion.div>
                    ) : (
                      <motion.div
                        layout
                        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, ease: "easeOut" }}
                        className="space-y-5 pb-8"
                      >
                        <AnimatePresence initial={false}>
                          {messages.map((m) => {
                            const trace     = thinking.getTrace(m.id);
                            const showTrace = m.role === "assistant" && (trace.steps.length > 0 || trace.isActive);
                            const showPlanPreview =
                              m.role === "assistant" &&
                              pendingPlan &&
                              pendingPlan.assistantMsgId === m.id;

                            return (
                              <motion.div
                                key={m.id}
                                layout
                                initial={{ opacity: 0, y: 14, scale: 0.985 }}
                                animate={{ opacity: 1, y: 0,  scale: 1 }}
                                exit={{ opacity: 0,   y: -8,  scale: 0.99 }}
                                transition={{ type: "spring", stiffness: 240, damping: 24 }}
                                className={`flex w-full ${m.role === "user" ? "justify-end" : "justify-start"}`}
                              >
                                <div className="group max-w-[min(92%,48rem)]">
                                  {m.role === "user" ? (
                                    <>
                                      <div className="rounded-[24px] border border-[#ff8a3d]/18 bg-gradient-to-br from-[#ff8a3d]/10 via-[#ff5e4d]/8 to-[#ff2d2d]/6 px-4 py-2 shadow-sm md:px-5 md:py-2.5 text-white">
                                        <div className="mb-2 flex items-center gap-2 text-xs text-white/32">
                                          <UserIcon className="h-4 w-4 text-[#ff8a3d]" />
                                          <span>You</span>
                                        </div>
                                        <div className="whitespace-pre-wrap text-[15px] leading-7 text-white/92">{m.content}</div>
                                      </div>
                                      <div className="mt-2 flex items-center justify-end gap-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                                        <motion.button
                                          whileTap={{ scale: 0.96 }}
                                          onClick={() => copyToClipboard(m.content, m.id)}
                                          className="inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 transition-colors hover:border-[#ff8a3d]/20 hover:bg-[#ff8a3d]/8 hover:text-white"
                                        >
                                          {copiedMessageId === m.id ? <><Check className="h-3.5 w-3.5 text-[#ff8a3d]" />Copied</> : <><Copy className="h-3.5 w-3.5" />Copy</>}
                                        </motion.button>
                                      </div>
                                    </>
                                  ) : (
                                    <div className="px-0 py-0 text-white">
                                      <div className="mb-2 flex items-center gap-2 text-xs text-white/30">
                                        <Bot className="h-4 w-4 text-[#ff8a3d]" />
                                        <span>Assistant</span>
                                      </div>

                                      {showTrace && (
                                        <div className="mb-4">
                                          <ThinkingTrace steps={trace.steps} log={trace.log} isActive={trace.isActive} startedAt={trace.startedAt} />
                                        </div>
                                      )}

                                      {/* Plan preview panel (ask mode) */}
                                      {showPlanPreview && pendingPlan && (
                                        <PlanPreviewPanel
                                          steps={pendingPlan.steps}
                                          onApprove={handleApprovePlan}
                                          onCancel={handleRejectPlan}
                                          isApproving={pendingPlan.isApproving}
                                        />
                                      )}

                                      {m.content ? (
                                        <AssistantMessage
                                          content={m.content}
                                          metadata={m.metadata}
                                          onUndoClick={
                                            undoableRequestId && m.metadata?.requestId === undoableRequestId
                                              ? () => handleUndoClick(m.id)
                                              : undefined
                                          }
                                          isUndoing={undoingMessageId === m.id}
                                        />
                                      ) : !trace.isActive && !showPlanPreview ? (
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
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-white/60 transition-colors hover:border-[#ff8a3d]/20 hover:bg-[#ff8a3d]/8 hover:text-white"
                                      >
                                        {copiedMessageId === m.id ? <><Check className="h-3.5 w-3.5 text-[#ff8a3d]" />Copied</> : <><Copy className="h-3.5 w-3.5" />Copy</>}
                                      </motion.button>
                                    </div>
                                  )}

                                  <div className="mt-1.5 px-1 text-[11px] text-white/24">
                                    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
                onStop={handleStop}
                onMessageKeyDown={handleMessageKeyDown}
                selectedFiles={selectedFiles}
                setSelectedFiles={setSelectedFiles}
                onSlashCommand={handleSlashCommand}
                permissionMode={permissionMode}
              />
            </div>

            {/* File tree right sidebar */}
            <FileTreeSidebar
              open={fileTreeOpen}
              onClose={() => setFileTreeOpen(false)}
              onFileSelect={handleFileTreeSelect}
            />
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}
