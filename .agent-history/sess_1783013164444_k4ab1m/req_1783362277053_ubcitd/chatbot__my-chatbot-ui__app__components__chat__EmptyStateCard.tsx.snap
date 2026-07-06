"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

export default function EmptyStateCard({
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