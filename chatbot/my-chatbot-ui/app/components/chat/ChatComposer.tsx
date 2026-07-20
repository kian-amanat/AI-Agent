"use client";

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpFromLine, Check, ChevronDown, ExternalLink, FileCode2, FolderOpen,
  GitBranch, GitCommit, GitPullRequest, Loader2, Mic, Paperclip, Shield,
  ShieldCheck, StopCircle, X,
} from "lucide-react";
import NorthRoundedIcon from "@mui/icons-material/NorthRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import {
  fetchGitBranches, fetchGitStatus, fetchWorkspaceRoots, gitCommit, gitPush,
  switchGitBranch, switchWorkspaceRoot, transcribeAudio,
  type GitBranchInfo, type GitStatus, type WorkspaceRootInfo,
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

  // Root (project folder) dropdown state — flat list of SIBLING project
  // folders (e.g. ai-sandbox and avand under the same parent dir), same
  // shape as the branch dropdown: no hierarchy, click a name, it switches.
  const [showRootDropdown, setShowRootDropdown] = React.useState(false);
  const [rootCurrent, setRootCurrent]           = React.useState<WorkspaceRootInfo | null>(null);
  const [rootOptions, setRootOptions]           = React.useState<WorkspaceRootInfo[]>([]);
  const [rootLoading, setRootLoading]           = React.useState(false);
  const [rootError, setRootError]               = React.useState<string | null>(null);
  const rootDropdownRef = React.useRef<HTMLDivElement>(null);

  // Unified Git panel — one button opens a popover with the contextual
  // commit / push / open-PR actions and a state summary, instead of three
  // separate pills scattered across the composer.
  const [showGitPanel, setShowGitPanel]   = React.useState(false);
  const [commitMessage, setCommitMessage] = React.useState("");
  const [committing, setCommitting]       = React.useState(false);
  const [commitError, setCommitError]     = React.useState<string | null>(null);
  const gitPanelRef = React.useRef<HTMLDivElement>(null);

  // Push state.
  const [pushing, setPushing]         = React.useState(false);
  const [pushError, setPushError]     = React.useState<string | null>(null);
  const [pushSuccess, setPushSuccess] = React.useState(false);

  // Close dropdowns on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
      if (rootDropdownRef.current && !rootDropdownRef.current.contains(e.target as Node)) {
        setShowRootDropdown(false);
      }
      if (gitPanelRef.current && !gitPanelRef.current.contains(e.target as Node)) {
        setShowGitPanel(false);
      }
    }
    if (showBranchDropdown || showRootDropdown || showGitPanel) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [showBranchDropdown, showRootDropdown, showGitPanel]);

  const refreshGitStatus = React.useCallback(async () => {
    try {
      const s = await fetchGitStatus();
      setGitStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  // Fetch git status on mount, refresh every 30 s
  React.useEffect(() => {
    async function poll() { await refreshGitStatus(); }
    void poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [refreshGitStatus]);

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
        await refreshGitStatus();
        setShowBranchDropdown(false);
      } catch (err) {
        setBranchError(err instanceof Error ? err.message : "Failed to switch branch");
      } finally {
        setBranchLoading(false);
      }
    },
    [refreshGitStatus]
  );

  const handleCommit = React.useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await gitCommit(commitMessage.trim());
      setCommitMessage("");
      // Keep the panel open — after committing, Push becomes the next action
      // right here, so the flow stays in one place.
      await refreshGitStatus();
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, refreshGitStatus]);

  const handlePush = React.useCallback(async () => {
    // Push only sends already-committed history — uncommitted changes would
    // silently be left behind, which is exactly the confusing case this
    // guards against. Commit (or discard) first.
    if (gitStatus?.dirty) {
      setPushError("You have uncommitted changes — commit them first, then push.");
      setTimeout(() => setPushError(null), 10000);
      return;
    }
    setPushing(true);
    setPushError(null);
    setPushSuccess(false);
    try {
      await gitPush();
      await refreshGitStatus();
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : "Push failed");
      setTimeout(() => setPushError(null), 10000);
    } finally {
      setPushing(false);
    }
  }, [gitStatus?.dirty, refreshGitStatus]);

  const toggleBranchDropdown = React.useCallback(() => {
    setShowBranchDropdown((p) => {
      if (!p) void loadBranches();
      return !p;
    });
  }, [loadBranches]);

  // Load sibling projects when dropdown opens — mirrors loadBranches exactly.
  const loadRoots = React.useCallback(async () => {
    setRootLoading(true);
    setRootError(null);
    try {
      const result = await fetchWorkspaceRoots();
      setRootCurrent(result.current);
      setRootOptions(result.options);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : "Failed to load folders");
    } finally {
      setRootLoading(false);
    }
  }, []);

  const handleRootSelect = React.useCallback(
    async (root: WorkspaceRootInfo) => {
      setRootLoading(true);
      setRootError(null);
      try {
        await switchWorkspaceRoot(root);
        // Refresh so the dropdown reflects the new current project
        const result = await fetchWorkspaceRoots();
        setRootCurrent(result.current);
        setRootOptions(result.options);
        setShowRootDropdown(false);
      } catch (err) {
        setRootError(err instanceof Error ? err.message : "Failed to switch folder");
      } finally {
        setRootLoading(false);
      }
    },
    []
  );

  const toggleRootDropdown = React.useCallback(() => {
    setShowRootDropdown((p) => {
      if (!p) void loadRoots();
      return !p;
    });
  }, [loadRoots]);

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
  // Root picker + permission pill are always available, so the status bar
  // itself is now always shown (previously it hid the permission pill too
  // whenever there was no git repo and no @mentions).
  const showStatusBar  = true;

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
                            className="absolute bottom-full left-0 z-[1000] mb-2 w-64 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
                          >
                            <div className="max-h-64 overflow-y-auto">
                              {/* Header */}
                              <div className="sticky top-0 border-b border-white/[0.05] bg-[#161616]/95 px-3 py-1.5 backdrop-blur-xl">
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
                                            : "text-white/50 hover:bg-white/[0.06] hover:text-white/70"
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
                            <div className="border-t border-white/[0.05] bg-[#161616]/95 px-3 py-1.5 backdrop-blur-xl">
                              <span className="text-[10px] text-white/18">
                                {branchLoading ? "Switching…" : `${branches.length} branch${branches.length !== 1 ? "es" : ""}`}
                              </span>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* ── Git panel — one button, all source-control actions inside.
                      Replaces the old scattered Commit/Push/PR pills: the button
                      shows at-a-glance state (dot when dirty, ↑N when ahead) and
                      opens a contextual popover that guides commit → push → PR. */}
                  {gitStatus && (() => {
                    const dirty = gitStatus.dirty;
                    const ahead = gitStatus.ahead;
                    const uncommitted = gitStatus.uncommittedCount ?? 0;
                    const canOpenPr = !!gitStatus.pullRequestUrl && !dirty;
                    const allClear = !dirty && ahead === 0 && !gitStatus.pullRequestUrl;
                    return (
                      <div className="relative shrink-0" ref={gitPanelRef}>
                        <button
                          type="button"
                          onClick={() => setShowGitPanel((p) => !p)}
                          disabled={isSending}
                          className={`flex items-center gap-1.5 rounded-md border px-2 py-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            dirty || ahead > 0
                              ? "border-[#ff8a3d]/25 bg-[#ff8a3d]/[0.06] hover:bg-[#ff8a3d]/12"
                              : "border-white/[0.06] bg-white/[0.03] hover:border-white/12 hover:bg-white/[0.06]"
                          }`}
                          title="Source control"
                        >
                          <GitCommit className={`h-3 w-3 ${dirty || ahead > 0 ? "text-[#ff8a3d]/70" : "text-white/25"}`} />
                          <span className={`text-[11px] ${dirty || ahead > 0 ? "text-[#ffb27d]" : "text-white/40"}`}>Git</span>
                          {dirty && <span className="h-[5px] w-[5px] rounded-full bg-[#ff8a3d]" title={`${uncommitted} uncommitted`} />}
                          {ahead > 0 && <span className="text-[10px] text-[#34d399]/80">↑{ahead}</span>}
                          <ChevronDown className="h-2.5 w-2.5 text-white/20 transition-transform duration-150" style={{ transform: showGitPanel ? "rotate(180deg)" : undefined }} />
                        </button>

                        <AnimatePresence>
                          {showGitPanel && (
                            <motion.div
                              initial={{ opacity: 0, y: 4, scale: 0.97 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: 4, scale: 0.97 }}
                              transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                              className="absolute bottom-full left-0 z-[1000] mb-2 w-80 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
                            >
                              {/* Header — branch + one-line state summary */}
                              <div className="border-b border-white/[0.06] px-3.5 py-2.5">
                                <div className="flex items-center gap-1.5">
                                  <GitBranch className="h-3 w-3 text-white/30" />
                                  <span className="font-mono text-[12px] text-white/70">{gitStatus.branch}</span>
                                </div>
                                <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-white/35">
                                  {dirty ? (
                                    <span className="flex items-center gap-1"><span className="h-[5px] w-[5px] rounded-full bg-[#ff8a3d]" />{uncommitted} uncommitted</span>
                                  ) : (
                                    <span className="flex items-center gap-1"><Check className="h-2.5 w-2.5 text-emerald-400/70" />clean</span>
                                  )}
                                  {ahead > 0 && <><span className="text-white/15">·</span><span className="text-[#34d399]/70">↑{ahead} to push</span></>}
                                  {!dirty && ahead === 0 && gitStatus.hasUpstream && <><span className="text-white/15">·</span><span>up to date</span></>}
                                </div>
                              </div>

                              <div className="flex flex-col gap-2.5 p-3">
                                {/* Step 1 — Commit (when there are changes) */}
                                {dirty && (
                                  <div>
                                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-white/25">Commit message</label>
                                    <textarea
                                      autoFocus
                                      value={commitMessage}
                                      onChange={(e) => setCommitMessage(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleCommit(); }
                                      }}
                                      placeholder="Describe what changed…"
                                      rows={2}
                                      className="w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-white/85 placeholder:text-white/20 outline-none transition-colors focus:border-[#ff8a3d]/40"
                                    />
                                    {commitError && <p className="mt-1.5 text-[11px] text-[#ff5e4d]/70">{commitError}</p>}
                                    <motion.button
                                      whileTap={{ scale: 0.98 }}
                                      type="button"
                                      onClick={() => void handleCommit()}
                                      disabled={committing || !commitMessage.trim()}
                                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#ff8a3d]/25 bg-[#ff8a3d]/10 px-3 py-2 text-[12px] font-medium text-[#ff8a3d] transition-colors hover:bg-[#ff8a3d]/18 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommit className="h-3.5 w-3.5" />}
                                      {committing ? "Committing…" : `Commit ${uncommitted} file${uncommitted !== 1 ? "s" : ""}`}
                                    </motion.button>
                                  </div>
                                )}

                                {/* Step 2 — Push (when there are commits ahead) */}
                                {ahead > 0 && (
                                  <div>
                                    <motion.button
                                      whileTap={{ scale: 0.98 }}
                                      type="button"
                                      onClick={() => void handlePush()}
                                      disabled={pushing || dirty}
                                      className={`flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                                        pushSuccess
                                          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                                          : "border-white/[0.1] bg-white/[0.04] text-white/70 hover:bg-white/[0.08]"
                                      }`}
                                    >
                                      {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : pushSuccess ? <Check className="h-3.5 w-3.5" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
                                      {pushing ? "Pushing…" : pushSuccess ? "Pushed" : `Push ↑${ahead}`}
                                    </motion.button>
                                    {dirty && <p className="mt-1.5 text-[10.5px] text-white/30">Commit your changes first, then push.</p>}
                                    {pushError && <p className="mt-1.5 text-[11px] leading-5 text-[#ff5e4d]/80">{pushError}</p>}
                                  </div>
                                )}

                                {/* Step 3 — Open pull request (tokenless GitHub link).
                                    When a GitHub token is configured in Settings, this
                                    is where an inline "Create PR" + status chip goes. */}
                                {canOpenPr && (
                                  <a
                                    href={gitStatus.pullRequestUrl!}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => setShowGitPanel(false)}
                                    className="flex items-center justify-center gap-1.5 rounded-xl border border-[#8957e5]/30 bg-[#8957e5]/10 px-3 py-2 text-[12px] font-medium text-[#b088f9] transition-colors hover:bg-[#8957e5]/18"
                                  >
                                    <GitPullRequest className="h-3.5 w-3.5" />
                                    Open pull request
                                    <ExternalLink className="h-3 w-3 opacity-60" />
                                  </a>
                                )}

                                {/* Nothing to do */}
                                {allClear && (
                                  <p className="py-1 text-center text-[11px] text-white/35">Nothing to commit or push — you&apos;re all caught up.</p>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })()}

                  {/* Root pill with dropdown — next to Branch. Switches between
                      SIBLING project folders (e.g. ai-sandbox / avand), not
                      subfolders of the current project. */}
                  <div className="relative shrink-0" ref={rootDropdownRef}>
                    <button
                      type="button"
                      onClick={toggleRootDropdown}
                      disabled={isSending || rootLoading}
                      className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-[3px] transition-colors hover:border-white/12 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                      title="Switch project folder"
                    >
                      <FolderOpen className="h-3 w-3 text-white/25" />
                      <span className="font-mono text-[11px] text-white/40">
                        {rootCurrent?.name ?? "root"}
                      </span>
                      <ChevronDown className="h-2.5 w-2.5 text-white/20 transition-transform duration-150" style={{ transform: showRootDropdown ? "rotate(180deg)" : undefined }} />
                    </button>

                    {/* Root dropdown */}
                    <AnimatePresence>
                      {showRootDropdown && (
                        <motion.div
                          initial={{ opacity: 0, y: 4, scale: 0.97 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 4, scale: 0.97 }}
                          transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                          className="absolute bottom-full left-0 z-[1000] mb-2 w-64 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
                        >
                          <div className="max-h-64 overflow-y-auto">
                            {/* Header */}
                            <div className="sticky top-0 border-b border-white/[0.05] bg-[#161616]/95 px-3 py-1.5 backdrop-blur-xl">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/25">
                                Projects
                              </span>
                            </div>

                            {rootLoading && rootOptions.length === 0 ? (
                              <div className="flex items-center justify-center gap-2 py-4">
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-white/30" />
                                <span className="text-[11px] text-white/30">Loading…</span>
                              </div>
                            ) : rootError ? (
                              <div className="px-3 py-4 text-center">
                                <span className="text-[11px] text-[#ff5e4d]/60">{rootError}</span>
                              </div>
                            ) : (
                              <ul className="py-1">
                                {rootOptions.map((r) => (
                                  <li key={r.path}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (!r.current) void handleRootSelect(r);
                                        else setShowRootDropdown(false);
                                      }}
                                      disabled={r.current || rootLoading}
                                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                                        r.current
                                          ? "bg-[#ff8a3d]/10 text-[#ff8a3d]/80"
                                          : "text-white/50 hover:bg-white/[0.06] hover:text-white/70"
                                      }`}
                                    >
                                      <FolderOpen className={`h-3 w-3 shrink-0 ${r.current ? "text-[#ff8a3d]/60" : "text-white/20"}`} />
                                      <span className="min-w-0 truncate font-mono">{r.name}</span>
                                      {r.current && (
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
                          <div className="border-t border-white/[0.05] bg-[#161616]/95 px-3 py-1.5 backdrop-blur-xl">
                            <span className="text-[10px] text-white/18">
                              {rootLoading ? "Switching…" : `${rootOptions.length} project${rootOptions.length !== 1 ? "s" : ""}`}
                            </span>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Divider between root/branch and files */}
                  {atMentions.length > 0 && (
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
