"use client";

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Mic, Paperclip, Send, StopCircle, X } from "lucide-react";

type ChatComposerProps = {
  messageInput: string;
  setMessageInput: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  isInputFocused: boolean;
  setIsInputFocused: (value: boolean) => void;
  isSending: boolean;
  isRecording: boolean;
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>;
  onSendMessage: () => void;
  onMessageKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  selectedFile: File | null;
  setSelectedFile: React.Dispatch<React.SetStateAction<File | null>>;
};

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
  onMessageKeyDown,
  selectedFile,
  setSelectedFile,
}: ChatComposerProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const canSend = Boolean(messageInput.trim() || selectedFile);

  return (
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
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,.pdf,.doc,.docx,.txt,.md,.json,.csv"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setSelectedFile(file);
                e.target.value = "";
              }}
            />

            <motion.button
              type="button"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => fileInputRef.current?.click()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-white/62 transition-colors duration-200 hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
              title="Attach file or image"
            >
              <Paperclip className="h-4 w-4" />
            </motion.button>

            <div className="min-w-0 flex-1">
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
                onKeyDown={onMessageKeyDown}
                placeholder="Message AI Assistant"
                rows={1}
                className="min-h-[44px] w-full resize-none bg-transparent px-1 py-2.5 text-[14px] leading-6 text-white outline-none placeholder:text-white/24"
                disabled={isSending}
              />

              <AnimatePresence initial={false}>
                {selectedFile && (
                  <motion.div
                    key={selectedFile.name}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    className="mt-1 flex items-center gap-2 rounded-xl border border-[#ff8a3d]/18 bg-[#ff8a3d]/8 px-2.5 py-1.5 text-xs text-white/84"
                  >
                    <span className="min-w-0 truncate">
                      📎 {selectedFile.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                      title="Remove attachment"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <motion.button
              type="button"
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
              type="button"
              whileHover={{ scale: isSending ? 1 : 1.03 }}
              whileTap={{ scale: isSending ? 1 : 0.96 }}
              onClick={onSendMessage}
              disabled={!canSend || isSending}
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
  );
}