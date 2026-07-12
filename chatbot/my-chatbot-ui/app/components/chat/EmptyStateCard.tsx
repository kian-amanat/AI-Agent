"use client";

import React, { useMemo } from "react";
import Image from "next/image";
import { motion } from "framer-motion";

function getGreeting() {
  const h = new Date().getHours();
  if (h < 5)  return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return      "Good night";
}

const CHIPS = [
  "Explain this codebase",
  "Fix the bug in @file",
  "Add TypeScript types",
  "Write tests for this",
  "Refactor to modern patterns",
];

const stagger = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

const up = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};

export default function EmptyStateCard({
  onSuggestion,
}: {
  onSuggestion?: (text: string) => void;
}) {
  const greeting = useMemo(getGreeting, []);

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className="mx-auto flex w-full max-w-xl flex-col items-center px-4 pb-8 pt-8 text-center"
    >
      {/* Icon */}
      <motion.div variants={up} className="mb-6">
        <Image
          src="/icon.png"
          alt="Kodo"
          width={52}
          height={52}
          className="rounded-[14px]"
          style={{ boxShadow: "0 4px 20px rgba(255,120,50,0.22)" }}
          priority
        />
      </motion.div>

      {/* Greeting */}
      <motion.h1
        variants={up}
        className="mb-1.5 text-[28px] font-semibold tracking-[-0.02em] text-white sm:text-[34px]"
      >
        {greeting},{" "}
        <span className="bg-gradient-to-r from-[#ff9a5c] to-[#ff4d3d] bg-clip-text text-transparent">
          Kian
        </span>
      </motion.h1>

      <motion.p variants={up} className="mb-8 text-[14px] text-white/35">
        What are we building today?
      </motion.p>

      {/* Chips */}
      <motion.div variants={up} className="flex flex-wrap justify-center gap-2">
        {CHIPS.map((chip) => (
          <button
            key={chip}
            onClick={() => onSuggestion?.(chip)}
            className="rounded-full border border-white/[0.07] bg-white/[0.03] px-4 py-2 text-[12.5px] text-white/45 transition-all duration-150 hover:border-[#ff8a3d]/30 hover:bg-[#ff8a3d]/8 hover:text-white/75"
          >
            {chip}
          </button>
        ))}
      </motion.div>

      {/* Hint */}
      <motion.p variants={up} className="mt-8 text-[11px] text-white/18">
        <Kbd>/</Kbd> commands &nbsp;·&nbsp; <Kbd>@file</Kbd> to target &nbsp;·&nbsp; <Kbd>⌘↵</Kbd> send
      </motion.p>
    </motion.div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded bg-white/[0.05] px-1.5 py-[2px] font-mono text-[10px] text-white/28">
      {children}
    </kbd>
  );
}
