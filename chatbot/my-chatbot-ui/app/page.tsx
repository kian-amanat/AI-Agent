"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { v4 as uuidv4 } from "uuid";
import {
  Search,
  Plus,
  MessageSquare,
  Sparkles,
  Send,
  Loader2,
  Paperclip,
  Mic,
  StopCircle,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Bot,
  User,
  MoreHorizontal,
  Layers,
  CheckCircle,
  Trash2,
} from "lucide-react";

import {
  fetchSessions,
  fetchSessionMessages,
  deleteSession,
  sendMessage,
  type Session,
  type Message as ApiMessage,
} from "./lib/api";
import { useRouter, useSearchParams } from "next/navigation";

type Role = "user" | "assistant";

interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  metadata?: {
    type?: string;
    intent?: string;
    plan_file?: string;
    plan_path?: string;
    plan_summary?: {
      name?: string;
      project_type?: string;
      goal?: string;
      tech_stack?: Record<string, string>;
      phases_count?: number;
      files_count?: number;
    };
    plan?: any;
    stage?: "analyzing" | "planning" | "validating" | "complete";
  };
}

interface Conversation {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  unread?: number;
}

interface PipelineStage {
  key: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const nowIso = () => new Date().toISOString();

const makeTitle = (text: string) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 34 ? `${clean.slice(0, 34)}…` : clean;
};

const AGENT_STAGES: PipelineStage[] = [
  {
    key: "intake",
    label: "Intake",
    description: "Reading the request",
    icon: Search,
  },
  {
    key: "context",
    label: "Context",
    description: "Scanning files and structure",
    icon: Layers,
  },
  {
    key: "plan",
    label: "Plan",
    description: "Designing the task flow",
    icon: Sparkles,
  },
  {
    key: "validate",
    label: "Validate",
    description: "Checking quality and constraints",
    icon: CheckCircle,
  },
  {
    key: "complete",
    label: "Complete",
    description: "Ready for review",
    icon: Bot,
  },
];

function toUiMessage(message: ApiMessage): Message {
  return {
    id: message.id != null ? String(message.id) : crypto.randomUUID(),
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
    metadata: {
      intent: message.intent ?? undefined,
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

function parseAssistantContent(content: string) {
  const sections: Array<{ type: string; content: string; language?: string }> = [];
  const lines = content.split("\n");
  let currentSection: { type: string; content: string; language?: string } | null = null;
  let inCodeBlock = false;
  let codeLanguage = "";

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        if (currentSection) sections.push(currentSection);
        codeLanguage = line.trim().replace(/```/g, "").trim();
        currentSection = { type: "code", content: "", language: codeLanguage };
        inCodeBlock = true;
      } else {
        if (currentSection) sections.push(currentSection);
        currentSection = null;
        inCodeBlock = false;
        codeLanguage = "";
      }
      return;
    }

    if (inCodeBlock && currentSection) {
      currentSection.content += (currentSection.content ? "\n" : "") + line;
      return;
    }

    if (line.match(/^[\s]*[•\-*]\s+/)) {
      if (currentSection?.type !== "bullet") {
        if (currentSection) sections.push(currentSection);
        currentSection = { type: "bullet", content: line };
      } else {
        currentSection.content += "\n" + line;
      }
      return;
    }

    if (line.match(/^[\s]*\d+\.\s+/)) {
      if (currentSection?.type !== "numbered") {
        if (currentSection) sections.push(currentSection);
        currentSection = { type: "numbered", content: line };
      } else {
        currentSection.content += "\n" + line;
      }
      return;
    }

    if (line.trim().match(/^#{1,6}\s+/)) {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: "header", content: line };
      sections.push(currentSection);
      currentSection = null;
      return;
    }

    if (line.trim().match(/^[-_]{3,}$/) && !line.includes("*")) {
      if (currentSection) sections.push(currentSection);
      sections.push({ type: "divider", content: "" });
      currentSection = null;
      return;
    }

    if (line.trim() === "") {
      if (currentSection?.type === "text" && currentSection.content.trim()) {
        sections.push(currentSection);
        currentSection = null;
      }
      return;
    }

    if (currentSection?.type === "text") {
      currentSection.content += "\n" + line;
    } else {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: "text", content: line };
    }
  });

  if (currentSection) sections.push(currentSection);
  return sections.filter((s) => s.content?.trim() || s.type === "divider");
}

function AssistantMessage({ content }: { content: string }) {
  const sections = parseAssistantContent(content);

  return (
    <div className="space-y-3">
      {sections.map((section, idx) => {
        if (section.type === "bullet") {
          const items = section.content.split("\n").filter((l) => l.trim());
          return (
            <ul key={idx} className="space-y-2">
              {items.map((item, i) => {
                let cleanText = item.trim();
                cleanText = cleanText.replace(/^[•\-*✓✗→◦▪▫■□●○◆◇★☆]+\s*/g, "");
                cleanText = cleanText.replace(/^\*+\s*/g, "");
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, "$1");
                cleanText = cleanText.trim();
                if (!cleanText) return null;

                return (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-1 text-white/30">•</span>
                    <span className="flex-1 text-[15px] leading-7 text-white/84">{cleanText}</span>
                  </li>
                );
              })}
            </ul>
          );
        }

        if (section.type === "numbered") {
          const items = section.content.split("\n").filter((l) => l.trim());
          return (
            <ol key={idx} className="space-y-2">
              {items.map((item, i) => {
                let cleanText = item.trim();
                cleanText = cleanText.replace(/^[\s]*\d+\.[\s]*/, "");
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, "$1");
                cleanText = cleanText.trim();
                if (!cleanText) return null;

                return (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="min-w-[24px] text-sm font-medium text-white/42">{i + 1}.</span>
                    <span className="flex-1 text-[15px] leading-7 text-white/84">{cleanText}</span>
                  </li>
                );
              })}
            </ol>
          );
        }

        if (section.type === "code") {
          return (
            <div
              key={idx}
              className="overflow-x-auto rounded-2xl border border-white/10 bg-[#0f0f0f] p-4 shadow-inner"
            >
              {section.language && (
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/35">
                  {section.language}
                </div>
              )}
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-white/88">
                {section.content}
              </pre>
            </div>
          );
        }

        if (section.type === "header") {
          const level = (section.content.match(/^#+/) || [""])[0].length;
          const text = section.content.replace(/^#+\s*/, "");
          const sizes = ["text-xl", "text-lg", "text-base", "text-base"];
          return (
            <h3
              key={idx}
              className={`${sizes[level - 1] || "text-base"} mb-1.5 mt-3 font-semibold text-white`}
            >
              {text}
            </h3>
          );
        }

        if (section.type === "divider") {
          return (
            <div
              key={idx}
              className="my-4 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
            />
          );
        }

        if (section.content.trim()) {
          return (
            <p key={idx} className="whitespace-pre-wrap text-[15px] leading-7 text-white/84">
              {section.content}
            </p>
          );
        }

        return null;
      })}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-1">
      <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-r from-[#ff8a3d] to-[#ff5e4d] [animation-delay:-0.2s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-r from-[#ff8a3d] to-[#ff5e4d] [animation-delay:-0.1s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-r from-[#ff8a3d] to-[#ff5e4d]" />
    </div>
  );
}

function EmptyStateCard({
  title,
  desc,
  onClick,
}: {
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ y: -2, scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className="group rounded-3xl border border-white/8 bg-white/[0.03] p-4 text-left transition-colors duration-200 hover:border-[#ff8a3d]/20 hover:bg-white/[0.045]"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/8 bg-gradient-to-br from-[#ff8a3d]/18 to-[#ff5e4d]/12 text-white/88">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">{title}</p>
          <p className="mt-1 text-xs leading-5 text-white/40">{desc}</p>
        </div>
      </div>
    </motion.button>
  );
}

function AgentPipelinePanel({
  task,
  stageIndex,
  progress,
  stages,
}: {
  task: string;
  stageIndex: number;
  progress: number;
  stages: PipelineStage[];
}) {
  const currentStage = stages[Math.min(stageIndex, stages.length - 1)];

  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.985 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mx-auto w-full max-w-4xl px-4 pt-4 md:px-8"
    >
      <div className="relative overflow-hidden rounded-[30px] border border-white/8 bg-white/[0.035] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.24)]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,94,77,0.14),transparent_40%),radial-gradient(circle_at_left,rgba(255,138,61,0.12),transparent_34%)]" />
        <div className="relative">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.35em] text-white/30">
                Running agent
              </div>
              <div className="mt-1 text-sm text-white/88">
                {task || "Processing request"}
              </div>
              <div className="mt-1 text-xs text-white/38">
                Current stage: {currentStage?.label} — {currentStage?.description}
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              <motion.span
                animate={{ scale: [1, 1.15, 1] }}
                transition={{ repeat: Infinity, duration: 1.35, ease: "easeInOut" }}
                className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-[#ff8a3d] via-[#ff5e4d] to-[#ff2d2d]"
              />
              <span className="text-xs text-white/50">{Math.round(progress)}%</span>
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-5">
            {stages.map((stage, idx) => {
              const Icon = stage.icon;
              const isActive = idx === stageIndex;
              const isDone = idx < stageIndex;

              return (
                <motion.div
                  key={stage.key}
                  layout
                  transition={{ type: "spring", stiffness: 280, damping: 24 }}
                  className={`relative overflow-hidden rounded-2xl border px-3 py-3 transition-all duration-300 ${
                    isActive
                      ? "border-[#ff8a3d]/25 bg-white/[0.06] shadow-[0_0_0_1px_rgba(255,138,61,0.12),0_0_32px_rgba(255,94,77,0.10)]"
                      : isDone
                      ? "border-white/10 bg-white/[0.04]"
                      : "border-white/6 bg-white/[0.025]"
                  }`}
                >
                  {isActive && (
                    <motion.div
                      aria-hidden
                      className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,138,61,0.14),transparent_55%)]"
                      animate={{ opacity: [0.6, 1, 0.6] }}
                      transition={{ repeat: Infinity, duration: 1.8 }}
                    />
                  )}

                  <div className="relative flex items-start gap-3">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all duration-300 ${
                        isActive
                          ? "border-[#ff8a3d]/30 bg-gradient-to-br from-[#ff8a3d]/18 to-[#ff5e4d]/12 text-white"
                          : isDone
                          ? "border-white/10 bg-white/[0.05] text-white"
                          : "border-white/8 bg-white/[0.025] text-white/55"
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${isActive ? "text-[#ffb38a]" : ""}`} />
                    </div>

                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white">{stage.label}</p>
                      <p className="mt-1 text-[11px] leading-5 text-white/38">
                        {stage.description}
                      </p>
                    </div>
                  </div>

                  <div className="relative mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <motion.div
                      className="h-full rounded-full bg-gradient-to-r from-[#ff8a3d] via-[#ff5e4d] to-[#ff2d2d]"
                      initial={false}
                      animate={{
                        width: isDone ? "100%" : isActive ? "72%" : "0%",
                      }}
                      transition={{ type: "spring", stiffness: 150, damping: 22 }}
                    />
                  </div>
                </motion.div>
              );
            })}
          </div>

          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-[#ff8a3d] via-[#ff5e4d] to-[#ff2d2d]"
              initial={false}
              animate={{ width: `${progress}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 22 }}
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
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
  const [sessionMessagesCache, setSessionMessagesCache] = useState<Record<string, Message[]>>({});
  const [isInputFocused, setIsInputFocused] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTask, setActiveTask] = useState("");
  const [pipelineStage, setPipelineStage] = useState(0);
  const [pipelineProgress, setPipelineProgress] = useState(0);

  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  let isMounted = true;

  async function loadSessionsAndMaybeOpen() {
    setLoadingSessions(true);
    try {
      const data = await fetchSessions();
      if (!isMounted) return;

      setSessions(data);

      // اول چک کن URL session داره
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
  setLoadingSessionId(sessionId);

  // آپدیت URL
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
  } finally {
    setLoadingSessionId((current) => (current === sessionId ? null : current));
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
      setMessages([]);
      setMessageInput("");

      if (nextSessions.length > 0) {
        await openSession(nextSessions[0].id); // این خودش URL رو آپدیت می‌کنه
      } else {
        router.push("/", { scroll: false }); // اگه session‌ای نموند
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
  setMessages([]);
  setMessageInput("");
  router.push("/", { scroll: false }); // پاک کردن session از URL
  setTimeout(() => textareaRef.current?.focus(), 50);
}


  async function handleSendMessage() {
    const text = messageInput.trim();
    if (!text || isSending) return;

    setIsSending(true);
    setIsProcessing(true);
    setActiveTask(text);
    setPipelineStage(0);
    setPipelineProgress(10);

    const userMessage: Message = {
      id: uuidv4(),
      role: "user",
      content: text,
      createdAt: nowIso(),
    };

    const assistantMessageId = uuidv4();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: nowIso(),
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
      selectedSessionIdRef.current,
      (chunk) => {
        setMessages((prev) => {
          const updated = prev.map((msg) =>
            msg.id === assistantMessageId ? { ...msg, content: msg.content + chunk } : msg
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
      },
      (returnedSessionId) => {
        const finalSessionId = returnedSessionId || selectedSessionIdRef.current;

        if (finalSessionId) {
          setSelectedSessionId(finalSessionId);
          setSessionMessagesCache((prev) => ({
            ...prev,
            [finalSessionId]: messagesRef.current,
          }));
          void refreshSessions(finalSessionId);
        }

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
        session.message_count > 0 ? `${session.message_count} message${session.message_count === 1 ? "" : "s"}` : "No messages yet"
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
    {
      title: "Show the agent pipeline",
      desc: "Make the current stage visible in chat.",
    },
    {
      title: "Use orange-red accents",
      desc: "Highlight important actions and progress.",
    },
    {
      title: "Add brilliant transitions",
      desc: "Make messages and inputs feel premium.",
    },
    {
      title: "Keep it minimal",
      desc: "Thin borders, calm surfaces, modern spacing.",
    },
  ];

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#161616] text-white">
      <motion.aside
        animate={{ width: isSidebarCollapsed ? 76 : 318 }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
        className="flex h-full shrink-0 flex-col border-r border-white/8 bg-[#151515]"
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/8 p-3">
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={() => setIsSidebarCollapsed((p) => !p)}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
            title={isSidebarCollapsed ? "Open sidebar" : "Collapse sidebar"}
          >
            {isSidebarCollapsed ? (
              <ChevronRight className="h-5 w-5" />
            ) : (
              <ChevronLeft className="h-5 w-5" />
            )}
          </motion.button>

          {!isSidebarCollapsed && (
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-white/8 bg-gradient-to-br from-[#ff8a3d]/18 to-[#ff5e4d]/12 text-white/88">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">AI Assistant</p>
                <p className="truncate text-xs text-white/40">Minimal Chat Workspace</p>
              </div>
            </div>
          )}

          {!isSidebarCollapsed && (
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={startNewChat}
              className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:border-[#ff8a3d]/25 hover:bg-[#ff8a3d]/10 hover:text-white"
              title="New chat"
            >
              <Plus className="h-5 w-5" />
            </motion.button>
          )}
        </div>

        {!isSidebarCollapsed && (
          <div className="border-b border-white/8 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <input
                value={conversationSearch}
                onChange={(e) => setConversationSearch(e.target.value)}
                placeholder="Search conversations"
                className="h-11 w-full rounded-2xl border border-white/8 bg-white/[0.03] pl-9 pr-3 text-sm text-white outline-none transition-all duration-300 placeholder:text-white/25 focus:border-[#ff8a3d]/30 focus:bg-white/[0.05]"
              />
            </div>

            <motion.button
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.99 }}
              onClick={startNewChat}
              className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3 text-left transition-colors duration-200 hover:border-[#ff8a3d]/20 hover:bg-[#ff8a3d]/8"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff6a3d] via-[#ff4d3d] to-[#ff2d2d] text-white shadow-[0_10px_22px_rgba(255,77,61,0.18)]">
                <Plus className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">New chat</p>
                <p className="truncate text-xs text-white/35">Start a fresh conversation</p>
              </div>
            </motion.button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loadingSessions && sessions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-white/40">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading conversations...
            </div>
          ) : (
            filteredConversations.map((conversation) => {
              const isSelected = selectedSessionId === conversation.id;

return (
  <motion.div
    key={conversation.id}
    whileHover={{ x: 1 }}
    whileTap={{ scale: 0.99 }}
    onClick={() => openSession(conversation.id)}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => e.key === "Enter" && openSession(conversation.id)}
    className={`group mb-1 flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition-all duration-200 ${
      isSelected
        ? "border border-[#ff8a3d]/20 bg-white/[0.06]"
        : "border border-transparent hover:bg-white/[0.04]"
    }`}
    title={conversation.title}
  >
    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-white/70 transition-colors group-hover:border-white/12 group-hover:bg-white/[0.05] group-hover:text-white">
      <MessageSquare className="h-4 w-4" />
    </div>

    {!isSidebarCollapsed && (
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-medium text-white">{conversation.title}</p>
          <span className="shrink-0 text-[11px] text-white/28">{conversation.updatedAt}</span>
        </div>
        <p className="mt-1 truncate text-xs leading-5 text-white/38">
          {conversation.preview}
        </p>
      </div>
    )}

    {!isSidebarCollapsed && (
      <div className="mt-1 flex items-center gap-1 opacity-0 transition-all duration-200 group-hover:opacity-100">
        <button
          onClick={(e) => {
            e.stopPropagation();
            void handleDeleteSession(conversation.id);
          }}
          className="rounded-lg p-1 text-white/25 transition-colors hover:bg-white/[0.04] hover:text-white/75"
          title="Delete conversation"
        >
          <Trash2 className="h-4 w-4" />
        </button>

        <div className="rounded-lg p-1 text-white/22 hover:bg-white/[0.04] hover:text-white/70">
          <MoreHorizontal className="h-4 w-4" />
        </div>
      </div>
    )}
  </motion.div>
);

            })
          )}
        </div>

        <div className="border-t border-white/8 p-3">
          <button className="flex w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3 text-left transition-colors duration-200 hover:bg-white/[0.05]">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/8 bg-white/[0.04]">
              <User className="h-4 w-4 text-white/80" />
            </div>
            {!isSidebarCollapsed && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">Kian</p>
                <p className="truncate text-xs text-white/35">Free plan</p>
              </div>
            )}
            {!isSidebarCollapsed && <MoreHorizontal className="h-4 w-4 text-white/25" />}
          </button>
        </div>
      </motion.aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[#161616]">
        <header className="flex h-14 items-center justify-between border-b border-white/8 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setIsSidebarCollapsed((p) => !p)}
              className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:bg-white/[0.05] hover:text-white md:hidden"
              title="Toggle sidebar"
            >
              <ChevronRight className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-white/8 bg-gradient-to-br from-[#ff8a3d]/18 to-[#ff5e4d]/12 text-white/88">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">AI Assistant</p>
                <p className="truncate text-xs text-white/35">Modern minimal chat interface</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:bg-white/[0.05] hover:text-white">
              <Search className="h-4 w-4" />
            </button>
          </div>
        </header>

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

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
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
                          className={`flex w-full ${m.role === "user" ? "justify-end" : "justify-start"}`}
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
                                    <User className="h-4 w-4 text-[#ff8a3d]" />
                                    <span>You</span>
                                  </>
                                )}
                              </div>

                              {m.role === "assistant" ? (
                                m.content ? (
                                  <AssistantMessage content={m.content} />
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

          <div className="border-t border-white/8 bg-[#161616] px-4 pb-4 pt-3 md:px-8">
            <div className="mx-auto w-full max-w-4xl">
              <motion.div
                animate={
                  isInputFocused
                    ? {
                        boxShadow:
                          "0 0 0 1px rgba(255,138,61,0.22), 0 20px 60px rgba(0,0,0,0.22)",
                      }
                    : {
                        boxShadow:
                          "0 0 0 1px rgba(255,255,255,0.06), 0 18px 50px rgba(0,0,0,0.18)",
                      }
                }
                transition={{ duration: 0.22 }}
                className="rounded-[22px] border border-white/8 bg-white/[0.03] p-2.5 backdrop-blur-sm"
              >
                <div className="flex items-end gap-2">
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.96 }}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-white/62 transition-colors duration-200 hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
                  >
                    <Paperclip className="h-4 w-4" />
                  </motion.button>

                  <textarea
                    ref={textareaRef}
                    value={messageInput}
                    onFocus={() => setIsInputFocused(true)}
                    onBlur={() => setIsInputFocused(false)}
                    onChange={(e) => {
                      setMessageInput(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
                    }}
                    onKeyDown={handleMessageKeyDown}
                    placeholder="Message AI Assistant"
                    rows={1}
                    className="min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-[14px] leading-6 text-white outline-none placeholder:text-white/24"
                    disabled={isSending}
                  />

                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => setIsRecording((p) => !p)}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors duration-200 ${
                      isRecording
                        ? "border-[#ff5e4d]/30 bg-[#ff5e4d]/12 text-white"
                        : "border-white/8 bg-white/[0.03] text-white/62 hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
                    }`}
                    title="Voice"
                  >
                    {isRecording ? (
                      <StopCircle className="h-4.5 w-4.5" />
                    ) : (
                      <Mic className="h-4.5 w-4.5" />
                    )}
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: isSending ? 1 : 1.03 }}
                    whileTap={{ scale: isSending ? 1 : 0.96 }}
                    onClick={handleSendMessage}
                    disabled={!messageInput.trim() || isSending}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#ff8a3d]/20 bg-gradient-to-br from-[#ff6a3d] via-[#ff4d3d] to-[#ff2d2d] text-white shadow-[0_12px_26px_rgba(255,77,61,0.22)] transition-all duration-200 hover:shadow-[0_16px_32px_rgba(255,77,61,0.28)] disabled:cursor-not-allowed disabled:opacity-45"
                    title="Send"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {isSending ? (
                        <motion.span
                          key="loading"
                          initial={{ opacity: 0, scale: 0.9, rotate: -8 }}
                          animate={{ opacity: 1, scale: 1, rotate: 0 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                        >
                          <Loader2 className="h-4.5 w-4.5 animate-spin" />
                        </motion.span>
                      ) : (
                        <motion.span
                          key="send"
                          initial={{ opacity: 0, scale: 0.9, y: 1 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                        >
                          <Send className="h-4.5 w-4.5" />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.button>
                </div>
              </motion.div>

              <div className="mt-2 text-center text-xs text-white/28">
                Press Enter to send, Shift+Enter for new line
              </div>

              <div className="mt-2 text-center text-[11px] text-white/22">
                ChatGPT can make mistakes. Check important information.
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}