"use client";

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Cpu,
  FolderSearch,
  Code2,
  ShieldCheck,
  CircleCheckBig,
  Check,
  ChevronUp,
  ChevronDown,
  Activity,
} from "lucide-react";
import type { PipelineAgentEvent } from "../../hooks/useAgentPipeline";

type StageKey = "planner" | "reading" | "mutate_files" | "validate" | "complete";

const STAGES: { key: StageKey; label: string; sub: string; Icon: React.ElementType }[] = [
  { key: "planner",      label: "Planner",  sub: "Task planning",   Icon: Cpu },
  { key: "reading",      label: "Context",  sub: "Reading files",   Icon: FolderSearch },
  { key: "mutate_files", label: "Codegen",  sub: "Writing code",    Icon: Code2 },
  { key: "validate",     label: "Validate", sub: "Running checks",  Icon: ShieldCheck },
  { key: "complete",     label: "Done",     sub: "Ready to review", Icon: CircleCheckBig },
];

const CIRC = 2 * Math.PI * 16;

function clamp(n: number, a: number, b: number) { return Math.max(a, Math.min(b, n)); }

function truncate(text: string, max = 90) {
  if (!text) return "";
  const clean = text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

// Interpolate between orange → bright orange → light green based on pct
function getProgressColor(pct: number): { border: string; arc: [string, string]; dot: string; glow: string } {
  if (pct >= 100) {
    return {
      border: "rgba(74, 222, 128, 0.45)",   // green-400
      arc:    ["#4ade80", "#22c55e"],         // green
      dot:    "#4ade80",
      glow:   "rgba(74, 222, 128, 0.08)",
    };
  }
  if (pct >= 75) {
    // orange → yellow-green transition
    const t = (pct - 75) / 25;
    const r = Math.round(255 + (74  - 255) * t);
    const g = Math.round(138 + (222 - 138) * t);
    const b = Math.round(61  + (128 - 61)  * t);
    const brightness = 0.18 + t * 0.27; // border gets brighter
    return {
      border: `rgba(${r},${g},${b},${brightness})`,
      arc:    [`rgb(${r},${g},${b})`, `rgb(${Math.round(r*0.85)},${Math.round(g*0.85)},${Math.round(b*0.85)})`],
      dot:    `rgb(${r},${g},${b})`,
      glow:   `rgba(${r},${g},${b},0.06)`,
    };
  }
  if (pct >= 40) {
    // orange brightens as it climbs
    const t = (pct - 40) / 35;
    const alpha = 0.12 + t * 0.1;
    return {
      border: `rgba(255, 138, 61, ${alpha})`,
      arc:    ["#ff8a3d", "#ff3820"],
      dot:    "#ff6432",
      glow:   "rgba(255, 100, 50, 0.06)",
    };
  }
  // 0–40: dim orange
  return {
    border: "rgba(255, 138, 61, 0.12)",
    arc:    ["#ff8a3d", "#ff3820"],
    dot:    "#ff6432",
    glow:   "rgba(255, 100, 50, 0.04)",
  };
}

export default function AgentPipelinePanel({
  task,
  stageIndex,
  progress,
  liveLog = "",
  events = [],
  defaultCollapsed = false,
  onCollapsedChange,
}: {
  task: string;
  stageIndex: number;
  progress: number;
  liveLog?: string;
  events?: PipelineAgentEvent[];
  defaultCollapsed?: boolean;
  onCollapsedChange?: (v: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const safeIndex = clamp(stageIndex, 0, STAGES.length - 1);
  const pct       = clamp(progress, 0, 100);
  const arcOffset = CIRC * (1 - pct / 100);

  const colors = useMemo(() => getProgressColor(pct), [pct]);

  const toggle = () =>
    setCollapsed(v => {
      const nv = !v;
      onCollapsedChange?.(nv);
      return nv;
    });

  const latestLog = useMemo(() => {
    const log = [...events].reverse().find(e => e.type === "log") as any;
    const raw = liveLog || log?.message || "";
    return truncate(raw) || STAGES[safeIndex]?.sub || "";
  }, [events, liveLog, safeIndex]);

  const isDone = pct >= 100;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.99 }}
      transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="mx-auto w-full max-w-4xl px-4 pt-4 md:px-8"
    >
      {/* Card — border color transitions with progress */}
      <motion.div
        className="relative overflow-hidden rounded-2xl bg-[#141414] shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        animate={{ borderColor: colors.border }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        style={{ border: `1px solid ${colors.border}` }}
      >
        {/* Top accent — color follows progress */}
        <motion.div
          className="absolute inset-x-[25%] top-0 h-px"
          animate={{
            background: `linear-gradient(90deg, transparent, ${colors.arc[0]}55, transparent)`,
          }}
          transition={{ duration: 0.8 }}
        />

        {/* Ambient glow — color follows progress */}
        <motion.div
          className="pointer-events-none absolute -right-12 -top-10 h-[160px] w-[220px] rounded-full"
          animate={{ background: `radial-gradient(ellipse, ${colors.glow} 0%, transparent 70%)` }}
          transition={{ duration: 0.8 }}
        />

        <div className="relative px-5 pb-5 pt-4">

          {/* Header */}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">

              {/* Status indicator */}
              <div className="flex items-center gap-2 mb-1.5">
                <motion.span
                  animate={{
                    opacity: isDone ? 1 : [1, 0.15, 1],
                    backgroundColor: colors.dot,
                  }}
                  transition={{
                    opacity: { repeat: isDone ? 0 : Infinity, duration: 1.6, ease: "easeInOut" },
                    backgroundColor: { duration: 0.8 },
                  }}
                  className="h-[5px] w-[5px] flex-shrink-0 rounded-full"
                />
                <motion.span
                  animate={{ color: isDone ? "rgba(74,222,128,0.55)" : "rgba(255,255,255,0.25)" }}
                  transition={{ duration: 0.8 }}
                  className="text-[10px] font-medium uppercase tracking-widest"
                >
                  {isDone ? "Complete" : "Running"}
                </motion.span>
              </div>

              <p className="truncate text-sm font-medium text-white/85">
                {truncate(task, 80) || "Processing request"}
              </p>

              {/* Live log */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={latestLog.slice(0, 20)}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="mt-1 flex items-center gap-1.5"
                >
                  <motion.div animate={{ color: `${colors.arc[0]}70` }} transition={{ duration: 0.8 }}>
                    <Activity className="h-[11px] w-[11px] flex-shrink-0" strokeWidth={2} />
                  </motion.div>
                  <span className="truncate text-[11px] text-white/30">{latestLog}</span>
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">

              {/* Arc progress — color follows progress */}
              <div className="relative flex h-9 w-9 items-center justify-center">
                <svg className="absolute inset-0 -rotate-90" viewBox="0 0 38 38" width="38" height="38">
                  <defs>
                    <linearGradient id="ag-dyn" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor={colors.arc[0]} />
                      <stop offset="100%" stopColor={colors.arc[1]} />
                    </linearGradient>
                  </defs>
                  <circle cx="19" cy="19" r="16" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="2.5" />
                  <motion.circle
                    cx="19" cy="19" r="16"
                    fill="none"
                    stroke="url(#ag-dyn)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={CIRC}
                    animate={{ strokeDashoffset: arcOffset }}
                    transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
                  />
                </svg>
                <motion.span
                  animate={{ color: isDone ? "rgba(74,222,128,0.8)" : "rgba(255,255,255,0.6)" }}
                  transition={{ duration: 0.8 }}
                  className="relative z-10 text-[10px] font-semibold tabular-nums"
                >
                  {Math.round(pct)}%
                </motion.span>
              </div>

              {/* Collapse */}
              <button
                type="button"
                onClick={toggle}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03] text-white/35 transition-all hover:bg-white/[0.07] hover:text-white/70"
              >
                {collapsed
                  ? <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                  : <ChevronUp   className="h-3.5 w-3.5" strokeWidth={1.75} />
                }
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
                transition={{ duration: 0.24, ease: [0.25, 0.46, 0.45, 0.94] }}
              >
                {/* Stage cards */}
                <div className="mt-4 grid grid-cols-5 gap-1.5">
                  {STAGES.map((stage, idx) => {
                    const isActive = idx === safeIndex;
                    const isStgDone = idx < safeIndex;
                    const { Icon } = stage;

                    return (
                      <motion.div
                        key={stage.key}
                        layout
                        transition={{ type: "spring", stiffness: 350, damping: 30 }}
                        className={`relative overflow-hidden rounded-xl border p-2.5 transition-all duration-300 ${
                          isActive
                            ? "bg-white/[0.045]"
                            : isStgDone
                            ? "bg-white/[0.02]"
                            : "bg-white/[0.015]"
                        }`}
                        style={{
                          borderColor: isActive
                            ? colors.border
                            : isStgDone
                            ? "rgba(255,255,255,0.06)"
                            : "rgba(255,255,255,0.04)",
                        }}
                      >
                        {/* Active top accent */}
                        {isActive && (
                          <motion.div
                            className="absolute inset-x-0 top-0 h-px"
                            animate={{
                              background: `linear-gradient(90deg, transparent, ${colors.arc[0]}50, transparent)`,
                            }}
                            transition={{ duration: 0.8 }}
                          />
                        )}

                        {/* Icon */}
                        <motion.div
                          className={`relative z-10 mb-2 flex h-7 w-7 items-center justify-center rounded-lg border transition-all duration-300 ${
                            isStgDone ? "border-white/[0.08] bg-white/[0.04]" : "border-white/[0.05] bg-white/[0.025]"
                          }`}
                          style={isActive ? {
                            borderColor: `${colors.arc[0]}30`,
                            background: `${colors.arc[0]}12`,
                          } : {}}
                          animate={isActive && idx < 4 ? { y: [0, -1.5, 0] } : {}}
                          transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
                        >
                          {isStgDone ? (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: "spring", stiffness: 500, damping: 22 }}
                            >
                              <Check className="h-3 w-3 text-white/40" strokeWidth={2.5} />
                            </motion.div>
                          ) : (
                            <motion.div
                              animate={{ color: isActive ? colors.arc[0] : "rgba(255,255,255,0.22)" }}
                              transition={{ duration: 0.6 }}
                            >
                              <Icon className="h-[13px] w-[13px]" strokeWidth={1.75} />
                            </motion.div>
                          )}
                        </motion.div>

                        <p className={`relative z-10 text-[10px] font-medium leading-tight transition-colors duration-300 whitespace-nowrap ${
                          isActive ? "text-white/88" : isStgDone ? "text-white/42" : "text-white/22"
                        }`}>
                          {stage.label}
                        </p>

                        <p className={`relative z-10 mt-0.5 text-[9px] leading-[1.4] transition-colors duration-300 overflow-hidden text-ellipsis whitespace-nowrap ${
                          isStgDone ? "text-white/25" : "text-white/15"
                        }`}
                          style={isActive ? { color: `${colors.arc[0]}60` } : {}}
                        >
                          {isActive && idx < 4
                            ? latestLog.slice(0, 32) || stage.sub
                            : isStgDone ? "Complete" : stage.sub}
                        </p>
                      </motion.div>
                    );
                  })}
                </div>

                {/* Progress bar */}
                <div className="mt-3 h-[1.5px] rounded-full bg-white/[0.05] overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    animate={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, ${colors.arc[0]}, ${colors.arc[1]})`,
                    }}
                    transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              </motion.div>
            ) : (
              /* Collapsed */
              <motion.div
                key="collapsed"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
                className="mt-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-1">
                  {STAGES.map((stage, idx) => {
                    const isActive  = idx === safeIndex;
                    const isStgDone = idx < safeIndex;
                    const { Icon }  = stage;
                    return (
                      <div
                        key={stage.key}
                        title={stage.label}
                        className={`relative flex h-6 w-6 items-center justify-center rounded-md border transition-all ${
                          isStgDone ? "border-white/[0.07] bg-white/[0.03]"
                          :           "border-white/[0.04] bg-white/[0.015]"
                        }`}
                        style={isActive ? {
                          borderColor: `${colors.arc[0]}25`,
                          background: `${colors.arc[0]}10`,
                        } : {}}
                      >
                        {isActive && (
                          <motion.span
                            animate={{ opacity: [0.4, 1, 0.4], backgroundColor: colors.dot }}
                            transition={{ opacity: { repeat: Infinity, duration: 1.6 }, backgroundColor: { duration: 0.8 } }}
                            className="absolute -right-px -top-px h-1 w-1 rounded-full"
                          />
                        )}
                        {isStgDone
                          ? <Check className="h-2.5 w-2.5 text-white/35" strokeWidth={2.5} />
                          : <motion.div animate={{ color: isActive ? colors.arc[0] : "rgba(255,255,255,0.18)" }} transition={{ duration: 0.6 }}>
                              <Icon className="h-2.5 w-2.5" strokeWidth={1.75} />
                            </motion.div>
                        }
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2">
                  <div className="w-16 h-[1.5px] rounded-full bg-white/[0.05] overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      animate={{
                        width: `${pct}%`,
                        background: `linear-gradient(90deg, ${colors.arc[0]}, ${colors.arc[1]})`,
                      }}
                      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
                    />
                  </div>
                  <motion.span
                    animate={{ color: isDone ? "rgba(74,222,128,0.55)" : "rgba(255,255,255,0.25)" }}
                    transition={{ duration: 0.8 }}
                    className="text-[10px] tabular-nums"
                  >
                    {Math.round(pct)}%
                  </motion.span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}