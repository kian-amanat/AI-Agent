"use client";

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { PipelineStage } from "./chat-types";

type StageKey = "planner" | "reading" | "mutate_files" | "validate" | "complete";

type AgentEvent =
  | { type: "stage"; stageKey: StageKey; at: number }
  | { type: "plan"; text: string; at: number }
  | { type: "read_files"; files: string[]; at: number }
  | { type: "file_update"; path: string; operation: "create" | "update"; diffSummary?: string; at: number }
  | { type: "validate"; result: "pass" | "fail"; notes?: string; at: number }
  | { type: "complete"; summary: string; at: number }
  | { type: "log"; stageKey?: StageKey; message: string; at: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function truncate(text: string, max = 140) {
  if (!text) return "";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function stageKeyFromIndex(idx: number): StageKey {
  return (["planner", "reading", "mutate_files", "validate", "complete"][clamp(idx, 0, 4)] as StageKey);
}

function deriveStageBlurb(stageKey: StageKey, events: AgentEvent[]) {
  // آخرین رویداد مرتبط با همین stage را پیدا می‌کنیم
  const reversed = [...events].reverse();

  const find = <T extends AgentEvent["type"]>(type: T) =>
    reversed.find((e) => e.type === type) as Extract<AgentEvent, { type: T }> | undefined;

  switch (stageKey) {
    case "planner": {
      const plan = find("plan");
      if (plan?.text) return { title: "Designing plan", body: truncate(plan.text, 180) };
      const log = reversed.find((e) => e.type === "log" && (e as any).stageKey === "planner") as any;
      return { title: "Designing plan", body: truncate(log?.message || "Generating a plan…") };
    }
    case "reading": {
      const rf = find("read_files");
      if (rf?.files?.length) return { title: "Reading files", body: truncate(rf.files.join(", "), 180) };
      const log = reversed.find((e) => e.type === "log" && (e as any).stageKey === "reading") as any;
      return { title: "Reading files", body: truncate(log?.message || "Scanning workspace…") };
    }
    case "mutate_files": {
      const fu = find("file_update");
      if (fu?.path) {
        const verb = fu.operation === "create" ? "Creating" : "Updating";
        return { title: "Create/Update", body: truncate(`${verb}: ${fu.path}${fu.diffSummary ? ` — ${fu.diffSummary}` : ""}`, 180) };
      }
      const log = reversed.find((e) => e.type === "log" && (e as any).stageKey === "mutate_files") as any;
      return { title: "Create/Update", body: truncate(log?.message || "Applying targeted changes…") };
    }
    case "validate": {
      const v = find("validate");
      if (v) return { title: "Validate", body: truncate(`${v.result.toUpperCase()}${v.notes ? ` — ${v.notes}` : ""}`, 180) };
      const log = reversed.find((e) => e.type === "log" && (e as any).stageKey === "validate") as any;
      return { title: "Validate", body: truncate(log?.message || "Checking constraints…") };
    }
    case "complete": {
      const c = find("complete");
      if (c?.summary) return { title: "Complete", body: truncate(c.summary, 180) };
      return { title: "Complete", body: "Ready for review." };
    }
  }
}

export default function AgentPipelinePanel({
  task,
  stageIndex,
  progress,
  stages,
  events = [],
  defaultCollapsed = false,
  onCollapsedChange,
}: {
  task: string;
  stageIndex: number;
  progress: number;
  stages: PipelineStage[]; // باید 5 stage مطابق کلیدها باشد
  events?: AgentEvent[];
  defaultCollapsed?: boolean;
  onCollapsedChange?: (v: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const safeStageIndex = clamp(stageIndex, 0, Math.max(0, stages.length - 1));
  const currentStage = stages[safeStageIndex];

  const currentStageKey = useMemo(() => stageKeyFromIndex(safeStageIndex), [safeStageIndex]);
  const blurb = useMemo(() => deriveStageBlurb(currentStageKey, events), [currentStageKey, events]);

  const pct = clamp(progress, 0, 100);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const nv = !v;
      onCollapsedChange?.(nv);
      return nv;
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.985 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mx-auto w-full max-w-4xl px-4 pt-4 md:px-8"
    >
      <div className="relative overflow-hidden rounded-[30px] border border-white/8 bg-white/[0.035] shadow-[0_18px_60px_rgba(0,0,0,0.24)]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,94,77,0.14),transparent_40%),radial-gradient(circle_at_left,rgba(255,138,61,0.12),transparent_34%)]" />

        <div className="relative p-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.35em] text-white/30">
                Running agent
              </div>

              {/* title + short blurb based on REAL events */}
              <div className="mt-1 text-sm text-white/88">
                {task || "Processing request"}
              </div>

              <div className="mt-1 text-xs text-white/38">
                Current stage: {currentStage?.label} — {blurb.title}
                <span className="block mt-1 text-[11px] text-white/45">
                  {blurb.body}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* percent pill */}
              <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
                <motion.span
                  animate={{ scale: [1, 1.15, 1] }}
                  transition={{ repeat: Infinity, duration: 1.35, ease: "easeInOut" }}
                  className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-[#ff8a3d] via-[#ff5e4d] to-[#ff2d2d]"
                />
                <span className="text-xs text-white/50">{Math.round(pct)}%</span>
              </div>

              {/* collapse button (X when open, chevron when collapsed—feel free) */}
              <button
                type="button"
                onClick={toggleCollapsed}
                className="group inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-white/70 hover:bg-white/[0.05] hover:text-white transition"
                aria-label={collapsed ? "Open agent panel" : "Close agent panel"}
                title={collapsed ? "Open" : "Close"}
              >
                {/* simple X icon */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="opacity-90 group-hover:opacity-100">
                  {collapsed ? (
                    // "expand" icon
                    <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  ) : (
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  )}
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <AnimatePresence initial={false} mode="popLayout">
            {!collapsed ? (
              <motion.div
                key="expanded"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: "easeOut" }}
              >
                <div className="mt-4 grid gap-2 sm:grid-cols-5">
                  {stages.map((stage, idx) => {
                    const Icon = stage.icon;
                    const isActive = idx === safeStageIndex;
                    const isDone = idx < safeStageIndex;

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
                      </motion.div>
                    );
                  })}
                </div>

                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-[#ff8a3d] via-[#ff5e4d] to-[#ff2d2d]"
                    initial={false}
                    animate={{ width: `${pct}%` }}
                    transition={{ type: "spring", stiffness: 120, damping: 22 }}
                  />
                </div>
              </motion.div>
            ) : (
              // Collapsed: thin icon-only bar
              <motion.div
                key="collapsed"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18 }}
                className="mt-3 flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  {stages.map((stage, idx) => {
                    const Icon = stage.icon;
                    const isActive = idx === safeStageIndex;
                    const isDone = idx < safeStageIndex;

                    return (
                      <div
                        key={stage.key}
                        className={`relative flex h-9 w-9 items-center justify-center rounded-xl border ${
                          isActive
                            ? "border-[#ff8a3d]/30 bg-white/[0.06]"
                            : isDone
                            ? "border-white/10 bg-white/[0.04]"
                            : "border-white/8 bg-white/[0.02]"
                        }`}
                        title={stage.label}
                        aria-label={stage.label}
                      >
                        {isActive && (
                          <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-[#ff8a3d]" />
                        )}
                        <Icon className={`h-4 w-4 ${isActive ? "text-[#ffb38a]" : "text-white/65"}`} />
                      </div>
                    );
                  })}
                </div>

                <div className="text-[11px] text-white/45">
                  {Math.round(pct)}%
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
