"use client";

import React, { useRef, useState, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import { 
  Search, 
  Layers, 
  CheckCircle, 
  Sparkles, 
  Send, 
  Code2,
  Loader2,
  Paperclip,
  Mic,
  StopCircle,
  Image as ImageIcon,
  Moon,
  Sun,
  Copy,
  Check,
  Plus
} from "lucide-react";

type Role = "user" | "assistant";

interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  metadata?: {
    type?: string;
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
  const lines = content.split('\n');
  let currentSection: { type: string; content: string; language?: string } | null = null;
  let inCodeBlock = false;
  let codeLanguage = '';

  lines.forEach((line) => {
    if (line.trim().startsWith('```')) {
if (!inCodeBlock) {
if (currentSection) sections.push(currentSection);
codeLanguage = line.trim().replace(/```/g, '').trim();
        currentSection = { type: 'code', content: '', language: codeLanguage };
        inCodeBlock = true;
      } else {
        if (currentSection) sections.push(currentSection);
        currentSection = null;
        inCodeBlock = false;
        codeLanguage = '';
      }
      return;
    }

    if (inCodeBlock && currentSection) {
      currentSection.content += (currentSection.content ? '\n' : '') + line;
      return;
    }

    if (line.match(/^[\s]*[•\-*]\s+/)) {
      if (currentSection?.type !== 'bullet') {
        if (currentSection) sections.push(currentSection);
        currentSection = { type: 'bullet', content: line };
      } else {
        currentSection.content += '\n' + line;
      }
      return;
    }

    if (line.match(/^[\s]*\d+\.\s+/)) {
      if (currentSection?.type !== 'numbered') {
        if (currentSection) sections.push(currentSection);
        currentSection = { type: 'numbered', content: line };
      } else {
        currentSection.content += '\n' + line;
      }
      return;
    }

    if (line.trim().match(/^#{1,6}\s+/)) {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: 'header', content: line };
      sections.push(currentSection);
      currentSection = null;
      return;
    }

    if (line.trim().match(/^[-_]{3,}$/) && !line.includes('*')) {
      if (currentSection) sections.push(currentSection);
      sections.push({ type: 'divider', content: '' });
      currentSection = null;
      return;
    }

    if (line.trim() === '') {
      if (currentSection?.type === 'text' && currentSection.content.trim()) {
        sections.push(currentSection);
        currentSection = null;
      }
      return;
    }

    if (currentSection?.type === 'text') {
      currentSection.content += '\n' + line;
    } else {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: 'text', content: line };
    }
  });

  if (currentSection) sections.push(currentSection);
  return sections.filter(s => s.content?.trim() || s.type === 'divider');
}

function AssistantMessage({ content }: { content: string }) {
  const sections = parseAssistantContent(content);

  return (
    <div className="space-y-3">
      {sections.map((section, idx) => {
        if (section.type === 'bullet') {
          const items = section.content.split('\n').filter(l => l.trim());
          return (
            <ul key={idx} className="space-y-2 ml-1">
              {items.map((item, i) => {
                let cleanText = item.trim();
                
                cleanText = cleanText.replace(/^[•\-*✓✗→◦▪▫■□●○◆◇★☆]+\s*/g, '');
                cleanText = cleanText.replace(/^\*+\s*/g, '');
                cleanText = cleanText.replace(/^[\s]*\*+[\s]*/g, '');
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, '$1');
                
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

        if (section.type === 'numbered') {
          const items = section.content.split('\n').filter(l => l.trim());
          return (
            <ol key={idx} className="space-y-2 ml-1">
              {items.map((item, i) => {
                let cleanText = item.trim();
                cleanText = cleanText.replace(/^[\s]*\d+\.[\s]*/, '');
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, '$1');
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

        if (section.type === 'code') {
          return (
            <div key={idx} className="rounded-lg bg-black dark:bg-gray-950 p-3 overflow-x-auto border border-gray-800 dark:border-gray-700">
              {section.language && (
                <div className="text-xs text-gray-400 mb-2 font-mono">{section.language}</div>
              )}
              <pre className="text-sm text-gray-100 font-mono leading-relaxed">
                {section.content}
              </pre>
            </div>
          );
        }

        if (section.type === 'header') {
          const level = (section.content.match(/^#+/) || [''])[0].length;
          const text = section.content.replace(/^#+\s*/, '');
          const sizes = ['text-xl', 'text-lg', 'text-base', 'text-base'];
          return (
            <h3 key={idx} className={`${sizes[level - 1] || 'text-base'} font-semibold text-gray-900 dark:text-gray-100 mt-3 mb-1.5`}>
              {text}
            </h3>
          );
        }

        if (section.type === 'divider') {
          return <div key={idx} className="h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-gray-700 to-transparent my-3" />;
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
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
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
      setCurrentStage((prev) => {
        if (prev < PIPELINE_STAGES.length - 1) {
          return prev + 1;
        }
        return prev;
      });
    }, 1500);

    return () => clearInterval(interval);
  }, [isProcessing]);

  async function copyToClipboard(text: string, messageId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // ✅ تابع جدید برای خواندن SSE stream
async function callBackendStream(goal: string, assistantId: string) {
  const res = await fetch("http://localhost:9000/api/agent/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: goal,
      messages: messages,
    }),
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
        
        // ✅ اضافه کردن console.log برای دیباگ
        console.log("📦 Received SSE:", parsed);

        if (parsed.type === "content") {
          content += parsed.content;

          setMessages(prev =>
            prev.map(m =>
              m.id === assistantId
                ? { ...m, content }
                : m
            )
          );
        }

        if (parsed.type === "stage") {
          console.log("🔄 Stage changed to:", parsed.stage);
          const idx = PIPELINE_STAGES.findIndex(s => s.key === parsed.stage);
          if (idx !== -1) setCurrentStage(idx);
        }

        // ✅ اضافه کردن handle برای type: "done"
        if (parsed.type === "done") {
          console.log("✅ Stream completed");
          setIsProcessing(false);
          setCurrentStage(PIPELINE_STAGES.length - 1); // complete stage
        }

      } catch (e) {
        console.warn("⚠️ Failed to parse SSE:", data);
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
    
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      await callBackendStream(text, assistantMessageId);
      setIsProcessing(false);
    } catch (err: any) {
      setIsProcessing(false);

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content: "خطا در اتصال به backend:\n" + (err?.message || "خطای ناشناخته"),
              }
            : msg
        )
      );
    } finally {
      setIsSending(false);
      setCurrentStage(0);
    }
  }

  function handleMessageKeyDown(
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  }

  function togglePlanJson(messageId: string) {
    setExpandedPlanId((prev) => (prev === messageId ? null : messageId));
  }

  function toggleTheme() {
    setIsDarkMode((prev) => !prev);
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-screen w-full bg-white dark:bg-[#212121] text-gray-900 dark:text-gray-100 overflow-hidden transition-colors duration-200">
      <main className="flex flex-1 flex-col w-full">
        {/* Header */}
        <header className="flex h-14 items-center justify-between px-4 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-[#212121]">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900 dark:bg-gray-700">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-medium">AI Assistant</span>
          </div>
          
          <button
            onClick={toggleTheme}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Toggle theme"
          >
            {isDarkMode ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>
        </header>

        {/* Main Content */}
        <div className="flex flex-1 flex-col items-center overflow-hidden">
          <div className="flex flex-1 flex-col w-full max-w-3xl px-4 overflow-hidden">
            {/* Compact Colorful Pipeline */}
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
                          <Icon 
                            className={`h-3 w-3 transition-all duration-300 ${
                              isActive ? 'animate-pulse' : ''
                            }`} 
                          />
                          <span className={`text-xs transition-all duration-300`}>
                            {stage.label}
                          </span>
                        </div>
                        {idx < PIPELINE_STAGES.length - 1 && (
                          <div className="relative w-6 h-px">
                            <div className="absolute inset-0 bg-gray-200 dark:bg-gray-700 rounded-full" />
                            <div 
                              className={`absolute inset-0 rounded-full transition-all duration-500 ${
                                isComplete 
                                  ? 'bg-gradient-to-r from-blue-500 via-purple-500 to-orange-500 w-full' 
                                  : 'w-0'
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

            {/* Empty State or Message History */}
            {isEmpty ? (
              <div className="flex-1 flex flex-col items-center justify-center pb-32">
                <h1 className="text-3xl font-normal text-gray-100 dark:text-gray-100 mb-8">
                  What's on the agenda today?
                </h1>
              </div>
            ) : (
              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto py-4 space-y-4 scroll-smooth"
                style={{
                  scrollbarWidth: 'thin',
                  scrollbarColor: isDarkMode ? '#4b5563 transparent' : '#d1d5db transparent'
                }}
              >
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex flex-col ${
                      m.role === "user" ? "items-end" : "items-start"
                    } animate-fadeIn px-2`}
                  >
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
                          <div className="text-[15px] leading-relaxed whitespace-pre-wrap">
                            {m.content}
                          </div>
                        )}

                        {m.metadata?.type === "plan" && m.metadata?.plan && (
                          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                            <button
                              onClick={() => togglePlanJson(m.id)}
                              className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
                            >
                              <Code2 className="h-3.5 w-3.5" />
                              {expandedPlanId === m.id ? "Hide JSON" : "View JSON"}
                            </button>

                            {expandedPlanId === m.id && (
                              <div className="mt-2 rounded-lg bg-black dark:bg-gray-950 p-3 overflow-x-auto">
                                <pre className="text-xs text-gray-100 font-mono leading-relaxed">
                                  {JSON.stringify(m.metadata.plan, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Copy Button */}
                      {m.content && (
                        <button
                          onClick={() => copyToClipboard(m.content, m.id)}
                          className="mt-1 flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors px-1"
                          title="Copy message"
                        >
                          {copiedMessageId === m.id ? (
                            <>
                              <Check className="h-3 w-3" />
                              <span>Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="py-4">
              <div className={`flex items-end gap-2 rounded-3xl border bg-white dark:bg-[#2f2f2f] px-4 py-2.5 shadow-sm transition-all ${
                isEmpty 
                  ? 'border-gray-700 dark:border-gray-700 focus-within:border-gray-600 dark:focus-within:border-gray-600' 
                  : 'border-gray-300 dark:border-gray-600 focus-within:border-gray-400 dark:focus-within:border-gray-500'
              }`}>
                <button
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  title="Attach file"
                >
                  <Plus className="h-5 w-5" />
                </button>

                <div className="flex-1 relative">
                  <textarea
                    ref={textareaRef}
                    className="w-full resize-none border-none bg-transparent text-[15px] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none max-h-32 leading-relaxed"
                    rows={1}
                    placeholder="Ask anything"
                    value={messageInput}
                    onChange={(e) => {
                      setMessageInput(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = Math.min(e.target.scrollHeight, 128) + "px";
                    }}
                    onKeyDown={handleMessageKeyDown}
                    disabled={isSending}
                  />
                </div>

                <button
                  onClick={() => setIsRecording(!isRecording)}
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
                    isRecording 
                      ? 'bg-red-500 text-white' 
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                  title="Voice input"
                >
                  <Mic className="h-4 w-4" />
                </button>

                <button
                  onClick={handleSendMessage}
                  disabled={isSending || !messageInput.trim()}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white dark:bg-white text-gray-900 dark:text-gray-900 transition-all hover:bg-gray-100 dark:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }

        ::-webkit-scrollbar {
          width: 6px;
        }

        ::-webkit-scrollbar-track {
          background: transparent;
        }

        ::-webkit-scrollbar-thumb {
          background: ${isDarkMode ? '#4b5563' : '#d1d5db'};
          border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: ${isDarkMode ? '#6b7280' : '#9ca3af'};
        }
      `}</style>
    </div>
  );
}
