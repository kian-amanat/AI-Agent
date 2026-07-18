"use client";

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown, FileCode2, GitBranch, Loader2, Mic, Paperclip,
  Shield, ShieldCheck, StopCircle, X,
} from "lucide-react";
import NorthRoundedIcon from "@mui/icons-material/NorthRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import {
  fetchGitBranches, fetchGitStatus, switchGitBranch, transcribeAudio,
  type GitBranchInfo, type GitStatus,
} from "../../lib/api";
import SlashCommandPalette, { type SlashCommandId } from "./SlashCommandPalette";

type PermissionMode = "auto" | "ask";

type ChatComposerProps = {
  messageInput:      string;
  setMessageInput:   (value: string) => void;
  textareaRef:       React.RefObject<HTMLTextAreaElement | null>;
  isInputFocused:    boolean;
  setIsInputFocused: (value: boolean) => void;
  isSending:         boolean;
  isRecording:       boolean;
  setIsRecording:    React.Dispatch<React.SetStateAction<boolean>>;
  onSendMessage:     () => void;
  onStop?:           () => void;
  onMessageKeyDown:  (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  selectedFiles:     File[];
  setSelectedFiles:  React.Dispatch<React.SetStateAction<File[]>>;
  onSlashCommand?:   (id: SlashCommandId) => void;
  permissionMode?:   PermissionMode;
};

function mergeFiles(existing: File[], incoming: File[]) {
  const seen = new Set(
    existing.map((f) => `${f.name}_${f.size}_${f.lastModified}`)
  );
  const merged = [...existing];
  for (const f of incoming) {
    const key = `${f.name}_${f.size}_${f.lastModified}`;
    if (!seen.has(key)) { seen.add(key); merged.push(f); }
  }
  return merged;
}

// Extract @path/file.ext mentions from message text
function extractMentions(text: string): string[] {
  const matches = text.match(/@([\w./\\-]+\.[a-zA-Z0-9]{1,10})/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

export default function ChatComposer({
  messageInput,
  setMessageInput,
  textareaRef,
  isInputFocused,
  setIsInputFocused,
  isSending,
  isRecording,
  setIsRecording,
  onSendMessage,
  onStop,
  onMessageKeyDown,
  selectedFiles,
  setSelectedFiles,
  onSlashCommand,
  permissionMode = "auto",
}: ChatComposerProps) {
  const fileInputRef     = React.useRef<HTMLInputElement>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const mediaStreamRef   = React.useRef<MediaStream | null>(null);
  const chunksRef        = React.useRef<BlobPart[]>([]);
  const mountedRef       = React.useRef(true);

  const [isTranscribing, setIsTranscribing] = React.useState(false);
  const [slashQuery, setSlashQuery]         = React.useState("");
  const [showPalette, setShowPalette]       = React.useState(false);
  const [gitStatus, setGitStatus]           = React.useState<GitStatus | null>(null);

  // Branch dropdown state
  const [showBranchDropdown, setShowBranchDropdown] = React.useState(false);
  const [branches, setBranches]                   = React.useState<GitBranchInfo[]>([]);
  const [branchLoading, setBranchLoading]         = React.useState(false);
  const [branchError, setBranchError]             = React.useState<string | null>(null);
  const branchDropdownRef = React.useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    }
    if (showBranchDropdown) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [showBranchDropdown]);

  // Fetch git status on mount, refresh every 30 s
  React.useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const s = await fetchGitStatus();
        if (!cancelled) setGitStatus(s);
      } catch {}
    }
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Load branches when dropdown opens
  const loadBranches = React.useCallback(async () => {
    setBranchLoading(true);
    setBranchError(null);
    try {
      const list = await fetchGitBranches();
      setBranches(list);
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : "Failed to load branches");
    } finally {
      setBranchLoading(false);
    }
  }, []);

  const handleBranchSelect = React.useCallback(
    async (branchName: string) => {
      setBranchLoading(true);
      setBranchError(null);
      try {
        await switchGitBranch(branchName);
        // Refresh git status to reflect new branch
        const s = await fetchGitStatus();
        setGitStatus(s);
        setShowBranchDropdown(false);
      } catch (err) {
        setBranchError(err instanceof Error ? err.message : "Failed to switch branch");
      } finally {
        setBranchLoading(false);
      }
    },
    []
  );

  const toggleBranchDropdown = React.useCallback(() => {
    setShowBranchDropdown((p) => {
      if (!p) void loadBranches();
      return !p;
    });
  }, [loadBranches]);

  // @-file mentions extracted from the current input
  const atMentions = React.useMemo(
    () => extractMentions(messageInput),
    [messageInput]
  );

  function removeMention(mention: string) {
    setMessageInput(messageInput.replace(new RegExp(`@${mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), "").replace(/\s{2,}/g, " ").trim());
  }

  function handleSlashSelect(id: SlashCommandId) {
    setShowPalette(false);
    setSlashQuery("");
    setMessageInput("");
    onSlashCommand?.(id);
  }

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items      = Array.from(e.clipboardData?.items ?? []);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      e.preventDefault();
      const newFiles: File[] = [];
      imageItems.forEach((item) => {
        const file = item.getAsFile();
        if (file) {
          const ext  = file.type.split("/")[1] || "png";
          const name = `screenshot-${Date.now()}.${ext}`;
          newFiles.push(new File([file], name, { type: file.type }));
        }
      });
      if (newFiles.length > 0) setSelectedFiles((prev) => mergeFiles(prev, newFiles));
    },
    [setSelectedFiles]
  );

  const canSend = Boolean(messageInput.trim() || selectedFiles.length > 0);

  const stopStreamTracks = React.useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
  }, []);

  const startRecording = React.useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setIsRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => setIsRecording(false);
      recorder.onstop = async () => {
        const mimeType  = recorder.mimeType || "audio/webm";
        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        stopStreamTracks();
        if (!audioBlob.size) return;
        setIsTranscribing(true);
        try {
          const transcript = (await transcribeAudio(audioBlob, "voice.webm")).trim();
          if (!mountedRef.current) return;
          if (transcript) {
            setMessageInput(transcript);
            if (textareaRef.current) {
              textareaRef.current.style.height = "auto";
              textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
            }
            window.setTimeout(() => onSendMessage(), 120);
          }
        } catch {}
        finally { if (mountedRef.current) setIsTranscribing(false); }
      };
      recorder.start();
    } catch {
      setIsRecording(false);
      stopStreamTracks();
    }
  }, [onSendMessage, setIsRecording, setMessageInput, stopStreamTracks, textareaRef]);

  const stopRecording = React.useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else stopStreamTracks();
    mediaRecorderRef.current = null;
  }, [stopStreamTracks]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; stopRecording(); stopStreamTracks(); };
  }, [stopRecording, stopStreamTracks]);

  React.useEffect(() => {
    if (isRecording) void startRecording();
    else stopRecording();
  }, [isRecording, startRecording, stopRecording]);

  const isAsk          = permissionMode === "ask";
  const showStatusBar  = gitStatus !== null || atMentions.length > 0;

  return (
    <div className="bg-transparent px-4 pb-5 pt-2 md:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <motion.div
          animate={
            isInputFocused
              ? { boxShadow: "0 0 0 1px rgba(255,138,61,0.22), 0 20px 60px rgba(0,0,0,0.22)" }
              : { boxShadow: "0 0 0 1px rgba(255,255,255,0.06), 0 18px 50px rgba(0,0,0,0.18)" }
          }
          transition={{ duration: 0.22 }}
          className="overflow-visible rounded-[22px] border border-white/8 bg-white/[0.03] backdrop-blur-sm"
        >
          {/* ── Main input row ─────────────────────────────── */}
          <div className="flex items-end gap-2 p-2.5">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              accept="image/*,.pdf,.doc,.docx,.txt,.md,.json,.csv"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) setSelectedFiles((prev) => mergeFiles(prev, files));
                e.target.value = "";
              }}
            />

            <motion.button
              type="button"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => fileInputRef.current?.click()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-white/62 transition-colors hover:border-white/12 hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              title="Attach file or image"
              disabled={isSending || isTranscribing}
            >
              <Paperclip className="h-4 w-4" />
            </motion.button>

            {/* Textarea + slash palette */}
            <div className="relative min-w-0 flex-1">
              <SlashCommandPalette
                query={slashQuery}
                visible={showPalette}
                onSelect={handleSlashSelect}
              />
              <textarea
                ref={textareaRef}
                value={messageInput}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => {
                  setIsInputFocused(false);
                  setTimeout(() => setShowPalette(false), 120);
                }}
                onChange={(e) => {
                  const val = e.target.value;
                  setMessageInput(val);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
                  if (val.startsWith("/") && !val.includes(" ")) {
                    setSlashQuery(val);
                    setShowPalette(true);
                  } else {
                    setShowPalette(false);
                    setSlashQuery("");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && showPalette) {
                    e.preventDefault();
                    setShowPalette(false);
                    return;
                  }
                  if (showPalette && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab")) {
                    e.preventDefault();
                    return;
                  }
                  onMessageKeyDown(e);
                }}
                onPaste={handlePaste}
                placeholder="Message Kodo  ·  type / for commands  ·  @file to target"
                rows={1}
                className="min-h-[44px] w-full resize-none bg-transparent px-1 py-2.5 text-[14px] leading-6 text-white outline-none placeholder:text-white/20"
                disabled={isSending || isTranscribing}
              />

              {/* Attached file chips */}
              <AnimatePresence initial={false}>
                {selectedFiles.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    className="mb-1 mt-2 flex flex-wrap gap-1.5"
                  >
                    {selectedFiles.map((file) => (
                      <div
                        key={`${file.name}_${file.size}_${file.lastModified}`}
                        className="flex max-w-full items-center gap-1.5 rounded-xl border border-[#ff8a3d]/20 bg-[#ff8a3d]/8 px-2.5 py-1 text-[12px] text-white/80"
                      >
                        <span className="min-w-0 truncate">📎 {file.name}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedFiles((prev) =>
                              prev.filter(
                                (item) =>
                                  !(item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)
                              )
                            )
                          }
                          className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                          disabled={isSending || isTranscribing}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Mic */}
            <motion.button
              type="button"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => setIsRecording((p) => !p)}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors duration-200 ${
                isTranscribing
                  ? "border-[#ff8a3d]/20 bg-[#ff8a3d]/10 text-white"
                  : isRecording
                  ? "border-[#ff5e4d]/30 bg-[#ff5e4d]/12 text-white"
                  : "border-white/8 bg-white/[0.03] text-white/62 hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
              }`}
              title={isRecording ? "Stop recording" : "Voice input"}
              disabled={isSending || isTranscribing}
            >
              {isTranscribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isRecording ? (
                <StopCircle className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </motion.button>

            {/* Send / Stop */}
            <motion.button
              type="button"
              whileHover={{ scale: isSending ? 1 : 1.03 }}
              whileTap={{ scale: isSending ? 1 : 0.96 }}
              animate={
                canSend && !isSending
                  ? {
                      scale: [1, 1.02, 1],
                      boxShadow: [
                        "0 12px 26px rgba(255,77,61,0.22)",
                        "0 14px 30px rgba(255,77,61,0.35)",
                        "0 12px 26px rgba(255,77,61,0.22)",
                      ],
                    }
                  : undefined
              }
              transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
              onClick={isSending ? () => onStop?.() : onSendMessage}
              disabled={isTranscribing || (!isSending && !canSend)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#ff8a3d]/20 bg-gradient-to-br from-[#ff6a3d] via-[#ff4d3d] to-[#ff2d2d] text-white shadow-[0_12px_26px_rgba(255,77,61,0.22)] transition-all duration-200 hover:shadow-[0_16px_32px_rgba(255,77,61,0.28)] disabled:cursor-not-allowed disabled:opacity-45"
              title={isSending ? "Stop" : "Send"}
            >
              <AnimatePresence mode="wait" initial={false}>
                {isSending ? (
                  <motion.span key="stop" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
                    <StopRoundedIcon className="h-4 w-4 text-white" />
                  </motion.span>
                ) : (
                  <motion.span key="send" initial={{ opacity: 0, scale: 0.9, y: 1 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }}>
                    <NorthRoundedIcon className="h-4 w-4" />
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          </div>

          {/* ── Status bar ────────────────────────────────── */}
          <AnimatePresence initial={false}>
            {showStatusBar && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="overflow-visible"
              >
                <div className="flex items-center gap-2 border-t border-white/[0.045] px-3.5 py-2">

                  {/* Branch pill with dropdown */}
                  {gitStatus && (
                    <div className="relative shrink-0" ref={branchDropdownRef}>
                      <button
                        type="button"
                        onClick={toggleBranchDropdown}
                        disabled={isSending || branchLoading}
                        className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-[3px] transition-colors hover:border-white/12 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                        title="Switch branch"
                      >
                        <GitBranch className="h-3 w-3 text-white/25" />
                        <span className="font-mono text-[11px] text-white/40">
                          {gitStatus.branch}
                        </span>
                        <ChevronDown className="h-2.5 w-2.5 text-white/20 transition-transform duration-150" style={{ transform: showBranchDropdown ? "rotate(180deg)" : undefined }} />
                        {gitStatus.dirty && (
                          <span
                            className="h-[5px] w-[5px] rounded-full bg-[#ff8a3d]/70 shrink-0"
                            title="Uncommitted changes"
                          />
                        )}
                        {gitStatus.ahead > 0 && (
                          <span className="text-[10px] text-[#34d399]/60">↑{gitStatus.ahead}</span>
                        )}
                      </button>

                      {/* Branch dropdown */}
                      <AnimatePresence>
                        {showBranchDropdown && (
                          <motion.div
                            initial={{ opacity: 0, y: 4, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 4, scale: 0.97 }}
                            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                            className="absolute bottom-full left-0 z-[1000] mb-2 w-64 overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.4)]"
                          >
                            <div className="max-h-64 overflow-y-auto">
                              {/* Header */}
                              <div className="sticky top-0 border-b border-white/[0.045] bg-white/[0.03] px-3 py-1.5 backdrop-blur-xl">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-white/25">
                                  Branches
                                </span>
                              </div>

                              {branchLoading && branches.length === 0 ? (
                                <div className="flex items-center justify-center gap-2 py-4">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin text-white/30" />
                                  <span className="text-[11px] text-white/30">Loading…</span>
                                </div>
                              ) : branchError ? (
                                <div className="px-3 py-4 text-center">
                                  <span className="text-[11px] text-[#ff5e4d]/60">{branchError}</span>
                                </div>
                              ) : (
                                <ul className="py-1">
                                  {branches.map((b) => (
                                    <li key={b.name}>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (!b.current) void handleBranchSelect(b.name);
                                          else setShowBranchDropdown(false);
                                        }}
                                        disabled={b.current || branchLoading}
                                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                                          b.current
                                            ? "bg-[#ff8a3d]/10 text-[#ff8a3d]/80"
                                            : "text-white/50 hover:bg-white/[0.04] hover:text-white/70"
                                        }`}
                                      >
                                        <GitBranch className={`h-3 w-3 shrink-0 ${b.current ? "text-[#ff8a3d]/60" : "text-white/20"}`} />
                                        <span className="min-w-0 truncate font-mono">{b.name}</span>
                                        {b.current && (
                                          <span className="ml-auto text-[10px] text-[#ff8a3d]/50">
                                            (current)
                                          </span>
                                        )}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            {/* Footer */}
                            <div className="border-t border-white/[0.045] bg-white/[0.03] px-3 py-1.5 backdrop-blur-xl">
                              <span className="text-[10px] text-white/18">
                                {branchLoading ? "Switching…" : `${branches.length} branch${branches.length !== 1 ? "es" : ""}`}
                              </span>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* Divider between branch and files */}
                  {gitStatus && atMentions.length > 0 && (
                    <span className="text-[10px] text-white/15 shrink-0">·</span>
                  )}

                  {/* @file mention chips */}
                  {atMentions.length > 0 && (
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                      {atMentions.map((mention) => {
                        const parts    = mention.split(/[/\\]/);
                        const filename = parts[parts.length - 1];
                        const dir      = parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
                        return (
                          <motion.div
                            key={mention}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.85 }}
                            transition={{ duration: 0.12 }}
                            className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-[2px] text-[11px]"
                          >
                            <FileCode2 className="h-2.5 w-2.5 shrink-0 text-[#ff8a3d]/60" />
                            {dir && (
                              <span className="text-white/25 font-mono">{dir}</span>
                            )}
                            <span className="font-mono text-white/60">{filename}</span>
                            <button
                              onClick={() => removeMention(mention)}
                              className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-white/30 transition-colors hover:bg-white/10 hover:text-white/70"
                              title={`Remove @${mention}`}
                            >
                              <X className="h-2 w-2" />
                            </button>
                          </motion.div>
                        );
                      })}
                    </div>
                  )}

                  {/* Permission mode pill — right side */}
                  <div
                    className={`ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] font-medium ${
                      isAsk
                        ? "text-[#ff8a3d]/80"
                        : "text-white/22"
                    }`}
                    title={isAsk ? "Ask mode: you approve each plan" : "Auto mode: changes apply automatically"}
                  >
                    {isAsk
                      ? <ShieldCheck className="h-2.5 w-2.5" />
                      : <Shield      className="h-2.5 w-2.5" />
                    }
                    <span>{isAsk ? "Ask" : "Auto"}</span>
                  </div>

                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Hint line */}
        <div className="mt-2 text-center text-[11px] text-white/18">
          Enter to send · Shift+Enter for new line · / for commands · @file to target
        </div>
      </div>
    </div>
  );
}
