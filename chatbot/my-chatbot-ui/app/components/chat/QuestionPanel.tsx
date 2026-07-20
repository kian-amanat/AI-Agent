"use client";

import React from "react";
import { motion } from "framer-motion";
import { HelpCircle, Loader2, Send } from "lucide-react";
import type { QuestionOption } from "../../lib/api";

export default function QuestionPanel({
  header,
  question,
  options,
  onAnswer,
  isAnswering,
}: {
  header:      string;
  question:    string;
  options:     QuestionOption[];
  onAnswer:    (answer: string) => void;
  isAnswering: boolean;
}) {
  const [freeText, setFreeText] = React.useState("");
  const hasOptions = options.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="my-3 overflow-hidden rounded-2xl border border-[#5fa8ff]/20 bg-[#141414]"
      style={{ boxShadow: "0 0 32px rgba(95,168,255,0.08)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-white/[0.06] px-4 py-3"
           style={{ background: "rgba(95,168,255,0.05)" }}>
        <HelpCircle className="h-3.5 w-3.5 text-[#5fa8ff]" />
        <span className="text-sm font-semibold text-white/85">{header || "Question"}</span>
      </div>

      {/* Question text */}
      <div className="px-4 py-3">
        <p className="text-[13px] leading-6 text-white/75">{question}</p>
      </div>

      {/* Options or free text */}
      <div className="flex flex-col gap-2 px-4 pb-4">
        {hasOptions ? (
          options.map((opt, i) => (
            <motion.button
              key={i}
              whileTap={{ scale: 0.98 }}
              onClick={() => !isAnswering && onAnswer(opt.label)}
              disabled={isAnswering}
              className="flex flex-col items-start gap-0.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 text-left transition-colors hover:border-[#5fa8ff]/30 hover:bg-[#5fa8ff]/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-[13px] font-medium text-white/85">{opt.label}</span>
              {opt.description && (
                <span className="text-[11px] text-white/40">{opt.description}</span>
              )}
            </motion.button>
          ))
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (freeText.trim() && !isAnswering) onAnswer(freeText.trim());
            }}
            className="flex items-center gap-2"
          >
            <input
              autoFocus
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              disabled={isAnswering}
              placeholder="Type your answer…"
              className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2 text-[13px] text-white/85 placeholder:text-white/25 outline-none transition-colors focus:border-[#5fa8ff]/40 disabled:opacity-50"
            />
            <motion.button
              type="submit"
              whileTap={{ scale: 0.96 }}
              disabled={isAnswering || !freeText.trim()}
              className="flex items-center gap-1.5 rounded-xl border border-[#5fa8ff]/25 bg-[#5fa8ff]/10 px-3 py-2 text-xs font-medium text-[#5fa8ff] transition-colors hover:bg-[#5fa8ff]/18 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isAnswering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send
            </motion.button>
          </form>
        )}
      </div>
    </motion.div>
  );
}
