"use client";

import React, { useRef, useState, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  Search,
  Layers,
  CheckCircle,
  Sparkles,
  Send,
  Loader2,
  Paperclip,
  Mic,
  StopCircle,
  Moon,
  Sun,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  FileJson,
} from "lucide-react";

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

const nowIso = () => new Date().toISOString();

const PIPELINE_STAGES = [
  {
    key: "analyzing",
    label: "Analyzing",
    icon: Search,
    activeColor: "text-blue-500",
    activeBg: "bg-blue-500/10",
    activeBorder: "border-blue-500/30",
  },
  {
    key: "planning",
    label: "Planning",
    icon: Layers,
    activeColor: "text-purple-500",
    activeBg: "bg-purple-500/10",
    activeBorder: "border-purple-500/30",
  },
  {
    key: "validating",
    label: "Validating",
    icon: CheckCircle,
    activeColor: "text-orange-500",
    activeBg: "bg-orange-500/10",
    activeBorder: "border-orange-500/30",
  },
  {
    key: "complete",
    label: "Complete",
    icon: Sparkles,
    activeColor: "text-green-500",
    activeBg: "bg-green-500/10",
    activeBorder: "border-green-500/30",
  },
];

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
            <ul key={idx} className="space-y-2 ml-1">
              {items.map((item, i) => {
                let cleanText = item.trim();
                cleanText = cleanText.replace(/^[•\-*✓✗→◦▪▫■□●○◆◇★☆]+\s*/g, "");
                cleanText = cleanText.replace(/^\*+\s*/g, "");
                cleanText = cleanText.replace(/^[\s]*\*+[\s]*/g, "");
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, "$1");
                cleanText = cleanText.trim();
                if (!cleanText) return null;

                return (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="text-gray-400 dark:text-gray-500 mt-1 text-sm flex-shrink-0">•</span>
                    <span className="flex-1 text-[15px] leading-relaxed text-gray-800 dark:text-gray-200">
                      {cleanText}
                    </span>
                  </li>
                );
              })}
            </ul>
          );
        }

        if (section.type === "numbered") {
          const items = section.content.split("\n").filter((l) => l.trim());
          return (
            <ol key={idx} className="space-y-2 ml-1">
              {items.map((item, i) => {
                let cleanText = item.trim();
                cleanText = cleanText.replace(/^[\s]*\d+\.[\s]*/, "");
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, "$1");
                cleanText = cleanText.trim();
                if (!cleanText) return null;

                return (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="text-gray-600 dark:text-gray-400 font-medium min-w-[24px] mt-0.5 text-sm flex-shrink-0">
                      {i + 1}.
                    </span>
                    <span className="flex-1 text-[15px] leading-relaxed text-gray-800 dark:text-gray-200">
                      {cleanText}
                    </span>
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
              className="rounded-lg bg-black dark:bg-gray-950 p-3 overflow-x-auto border border-gray-800 dark:border-gray-700"
            >
              {section.language && <div className="text-xs text-gray-400 mb-2 font-mono">{section.language}</div>}
              <pre className="text-sm text-gray-100 font-mono leading-relaxed">{section.content}</pre>
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
              className={`${sizes[level - 1] || "text-base"} font-semibold text-gray-900 dark:text-gray-100 mt-3 mb-1.5`}
            >
              {text}
            </h3>
          );
        }

        if (section.type === "divider") {
          return (
            <div
              key={idx}
              className="h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-gray-700 to-transparent my-3"
            />
          );
        }

        if (section.content.trim()) {
          return (
            <div key={idx}>
              <p className="text-[15px] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
                {section.content}
              </p>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

export default function MinimalChatComponent() {
  const [messageInput, setMessageInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [isDarkMode]);

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
    const interval = setInterval(() => {
      setCurrentStage((prev) => (prev < PIPELINE_STAGES.length - 1 ? prev + 1 : prev));
    }, 1500);
    return () => clearInterval(interval);
  }, [isProcessing]);

  async function copyToClipboard(text: string, messageId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }

  async function callBackendStream(goal: string, assistantId: string) {
    const res = await fetch("http://localhost:9000/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: goal, messages }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Backend error: ${res.status} ${text}`);
    }

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) throw new Error("No stream");

    let buffer = "";
    let content = "";
    let metadata: any = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.replace("data:", "").trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.type === "content") {
            content += parsed.content;
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content } : m)));
          }

          if (parsed.type === "progress") {
            const stageMap: Record<string, number> = { analyzing: 0, planning: 1, validating: 2 };
            if (parsed.stage && stageMap[parsed.stage] !== undefined) {
              setCurrentStage(stageMap[parsed.stage]);
            }
          }

          if (parsed.type === "plan_metadata") {
            metadata = { ...metadata, ...parsed };
          }

          if (parsed.type === "done") {
            setIsProcessing(false);
            setCurrentStage(PIPELINE_STAGES.length - 1);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, metadata: { ...m.metadata, ...parsed.metadata, ...metadata } }
                  : m
              )
            );
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  }

  async function handleSendMessage() {
    const text = messageInput.trim();
    if (!text || isSending) return;

    setIsSending(true);
    setIsProcessing(true);
    setCurrentStage(0);

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

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setMessageInput("");

    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      await callBackendStream(text, assistantMessageId);
      setIsProcessing(false);
    } catch (err: any) {
      setIsProcessing(false);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? { ...msg, content: "خطا در اتصال به backend:\n" + (err?.message || "خطای ناشناخته") }
            : msg
        )
      );
    } finally {
      setIsSending(false);
      setCurrentStage(0);
    }
  }

  function handleMessageKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  }

  function togglePlanJson(messageId: string) {
    setExpandedPlanId((prev) => (prev === messageId ? null : messageId));
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-screen w-full bg-white dark:bg-[#212121] text-gray-900 dark:text-gray-100 overflow-hidden transition-colors duration-200">
      <main className="flex flex-1 flex-col w-full">
        <header className="flex h-14 items-center justify-between px-4 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-[#212121]">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900 dark:bg-gray-700">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-medium">AI Assistant</span>
          </div>

          <button
            onClick={() => setIsDarkMode((p) => !p)}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Toggle theme"
          >
            {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </header>

        <div className="flex flex-1 flex-col items-center overflow-hidden">
          <div className="flex flex-1 flex-col w-full max-w-3xl px-4 overflow-hidden">
            {isProcessing && (
              <div className="py-3 flex items-center justify-center">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-gray-50/30 to-gray-100/30 dark:from-gray-800/20 dark:to-gray-800/30 rounded-full border border-gray-200/30 dark:border-gray-700/30 backdrop-blur-sm">
                  {PIPELINE_STAGES.map((stage, idx) => {
                    const Icon = stage.icon;
                    const isActive = idx === currentStage;
                    const isComplete = idx < currentStage;
                    return (
                      <React.Fragment key={stage.key}>
                        <div
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all duration-500 ${
                            isActive
                              ? `${stage.activeBg} ${stage.activeColor} font-medium border ${stage.activeBorder} scale-105`
                              : isComplete
                              ? "text-gray-400 dark:text-gray-500 scale-95"
                              : "text-gray-300 dark:text-gray-600 scale-90"
                          }`}
                        >
                          <Icon className={`h-3 w-3 transition-all duration-300 ${isActive ? "animate-pulse" : ""}`} />
                          <span className="text-xs">{stage.label}</span>
                        </div>
                        {idx < PIPELINE_STAGES.length - 1 && (
                          <div className="relative w-6 h-px">
                            <div className="absolute inset-0 bg-gray-200 dark:bg-gray-700 rounded-full" />
                            <div
                              className={`absolute inset-0 rounded-full transition-all duration-500 ${
                                isComplete
                                  ? "bg-gradient-to-r from-blue-500 via-purple-500 to-orange-500 w-full"
                                  : "w-0"
                              }`}
                            />
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {isEmpty ? (
              <div className="flex-1 flex flex-col items-center justify-center pb-32">
                <h1 className="text-3xl font-normal text-gray-100 dark:text-gray-100 mb-8">
                  What's on the agenda today?
                </h1>
              </div>
            ) : (
              <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 space-y-4 scroll-smooth">
                {messages.map((m) => (
                  <div key={m.id} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"} px-2`}>
                    <div className="max-w-[80%]">
                      <div
                        className={`rounded-2xl px-4 py-3 ${
                          m.role === "user"
                            ? "bg-gray-900 dark:bg-gray-700 text-white"
                            : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                        }`}
                      >
                        {m.role === "assistant" ? (
                          m.content ? (
                            <AssistantMessage content={m.content} />
                          ) : (
                            <div className="flex items-center gap-2 text-gray-500">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              <span className="text-sm">Thinking...</span>
                            </div>
                          )
                        ) : (
                          <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{m.content}</div>
                        )}

                        {/* Summary + thin lines + toggle JSON */}
                        {m.metadata?.type === "plan" && m.metadata?.plan_summary && (
                          <div className="mt-4">
                            <div className="h-px bg-gradient-to-r from-transparent via-gray-300 dark:via-gray-600 to-transparent mb-4" />

                            <div className="mb-4 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-850 p-5 border border-blue-100 dark:border-gray-700">
                              <div className="flex items-center gap-2 mb-4">
                                <Sparkles className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Plan Summary</h3>
                              </div>

                              <div className="space-y-2.5">
                                {m.metadata.plan_summary.name && (
                                  <div className="flex items-start gap-2.5">
                                    <span className="text-blue-500 mt-0.5 flex-shrink-0">•</span>
                                    <div>
                                      <span className="text-gray-600 dark:text-gray-400">Project: </span>
                                      <span className="text-gray-800 dark:text-gray-200 font-medium">{m.metadata.plan_summary.name}</span>
                                    </div>
                                  </div>
                                )}

                                {m.metadata.plan_summary.project_type && (
                                  <div className="flex items-start gap-2.5">
                                    <span className="text-purple-500 mt-0.5 flex-shrink-0">•</span>
                                    <div>
                                      <span className="text-gray-600 dark:text-gray-400">Type: </span>
                                      <span className="text-gray-800 dark:text-gray-200 font-medium">{m.metadata.plan_summary.project_type}</span>
                                    </div>
                                  </div>
                                )}

                                {m.metadata.plan_summary.goal && (
                                  <div className="flex items-start gap-2.5">
                                    <span className="text-green-500 mt-0.5 flex-shrink-0">•</span>
                                    <div>
                                      <span className="text-gray-600 dark:text-gray-400">Goal: </span>
                                      <span className="text-gray-800 dark:text-gray-200 font-medium">{m.metadata.plan_summary.goal}</span>
                                    </div>
                                  </div>
                                )}

                                {m.metadata.plan_summary.tech_stack &&
                                  Object.keys(m.metadata.plan_summary.tech_stack).length > 0 && (
                                    <div className="flex items-start gap-2.5">
                                      <span className="text-orange-500 mt-0.5 flex-shrink-0">•</span>
                                      <div className="flex-1">
                                        <span className="text-gray-600 dark:text-gray-400">Tech Stack: </span>
                                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                                          {Object.entries(m.metadata.plan_summary.tech_stack).map(([key, value]) => (
                                            <span
                                              key={key}
                                              className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs text-gray-700 dark:text-gray-300"
                                            >
                                              {key}: {value}
                                            </span>
                                          ))}
                                        </div>
                                      </div>
                                    </div>
                                  )}

                                {m.metadata.plan_summary.phases_count !== undefined && (
                                  <div className="flex items-start gap-2.5">
                                    <span className="text-pink-500 mt-0.5 flex-shrink-0">•</span>
                                    <div>
                                      <span className="text-gray-600 dark:text-gray-400">Phases: </span>
                                      <span className="text-gray-800 dark:text-gray-200 font-medium">{m.metadata.plan_summary.phases_count}</span>
                                    </div>
                                  </div>
                                )}

                                {m.metadata.plan_summary.files_count !== undefined && (
                                  <div className="flex items-start gap-2.5">
                                    <span className="text-cyan-500 mt-0.5 flex-shrink-0">•</span>
                                    <div>
                                      <span className="text-gray-600 dark:text-gray-400">Files: </span>
                                      <span className="text-gray-800 dark:text-gray-200 font-medium">{m.metadata.plan_summary.files_count}</span>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="h-px bg-gradient-to-r from-transparent via-gray-300 dark:via-gray-600 to-transparent my-4" />

                            <button
                              onClick={() => togglePlanJson(m.id)}
                              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg transition-colors"
                            >
                              <FileJson className="h-3.5 w-3.5" />
                              {expandedPlanId === m.id ? "Hide JSON" : "View JSON"}
                              {expandedPlanId === m.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </button>

                            {expandedPlanId === m.id && m.metadata?.plan && (
                              <div className="mt-3 rounded-lg bg-black dark:bg-gray-950 p-3 overflow-x-auto border border-gray-800 dark:border-gray-700">
                                <pre className="text-xs text-gray-100 font-mono leading-relaxed">
                                  {JSON.stringify(m.metadata.plan, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {m.role === "assistant" && m.content && (
                        <button
                          onClick={() => copyToClipboard(m.content, m.id)}
                          className="mt-2 flex items-center gap-1.5 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                        >
                          {copiedMessageId === m.id ? (
                            <>
                              <Check className="h-3 w-3" />
                              <span>Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      )}

                      <div className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
                        {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="py-4">
              <div className="relative flex items-end gap-2 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 shadow-sm">
                <button className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <Paperclip className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                </button>

                <textarea
                  ref={textareaRef}
                  value={messageInput}
                  onChange={(e) => {
                    setMessageInput(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
                  }}
                  onKeyDown={handleMessageKeyDown}
                  placeholder="Type your message..."
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none py-1.5 max-h-[200px] overflow-y-auto"
                  disabled={isSending}
                />

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setIsRecording(!isRecording)}
                    className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                      isRecording
                        ? "bg-red-500 text-white hover:bg-red-600"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                    }`}
                  >
                    {isRecording ? <StopCircle className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </button>

                  <button
                    onClick={handleSendMessage}
                    disabled={!messageInput.trim() || isSending}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-900 dark:bg-gray-700 text-white hover:bg-gray-800 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="mt-2 text-center text-xs text-gray-400 dark:text-gray-500">
                Press Enter to send, Shift+Enter for new line
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
