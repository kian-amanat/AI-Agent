"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Archive, Eraser, HelpCircle, RotateCcw } from "lucide-react";

export type SlashCommandId = "clear" | "compact" | "undo" | "help";

type Command = {
  id:          SlashCommandId;
  label:       string;
  description: string;
  Icon:        React.ElementType;
};

const COMMANDS: Command[] = [
  { id: "clear",   label: "/clear",   description: "Clear all messages in this conversation",  Icon: Eraser    },
  { id: "compact", label: "/compact", description: "Summarize conversation to free up context", Icon: Archive   },
  { id: "undo",    label: "/undo",    description: "Undo the last set of file changes",         Icon: RotateCcw },
  { id: "help",    label: "/help",    description: "Show available slash commands",              Icon: HelpCircle },
];

export default function SlashCommandPalette({
  query,
  visible,
  onSelect,
}: {
  query:    string;
  visible:  boolean;
  onSelect: (id: SlashCommandId) => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = COMMANDS.filter((c) =>
    c.id.startsWith(query.replace(/^\//, "").toLowerCase())
  );

  useEffect(() => { setActiveIdx(0); }, [query]);

  useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent) {
      if (!filtered.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[activeIdx]) onSelect(filtered[activeIdx].id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, filtered, activeIdx, onSelect]);

  return (
    <AnimatePresence>
      {visible && filtered.length > 0 && (
        <motion.div
          ref={listRef}
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.13, ease: "easeOut" }}
          className="absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#191919] shadow-[0_16px_48px_rgba(0,0,0,0.5)] z-50"
        >
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-white/25">
            Commands
          </div>
          {filtered.map((cmd, idx) => {
            const isActive = idx === activeIdx;
            return (
              <button
                key={cmd.id}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => onSelect(cmd.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors duration-100 ${
                  isActive ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
                }`}
              >
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                  isActive
                    ? "border-[#ff8a3d]/30 bg-[#ff8a3d]/10"
                    : "border-white/[0.06] bg-white/[0.03]"
                }`}>
                  <cmd.Icon className={`h-3.5 w-3.5 ${isActive ? "text-[#ff8a3d]" : "text-white/40"}`} />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-white/85">{cmd.label}</div>
                  <div className="truncate text-[11px] text-white/35">{cmd.description}</div>
                </div>
              </button>
            );
          })}
          <div className="border-t border-white/[0.05] px-3 py-1.5 text-[10px] text-white/20">
            ↑↓ navigate · Enter select · Esc dismiss
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
