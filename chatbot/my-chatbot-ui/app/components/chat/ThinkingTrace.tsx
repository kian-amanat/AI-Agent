"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, ChevronRight, Loader2, TerminalSquare } from "lucide-react";
import type { LogEntry } from "../../hooks/useThinkingSteps";

/* ── Types ─────────────────────────────────────────────────── */
export type ThinkingStepKind =
  | "route" | "explore" | "file_loaded" | "plan"
  | "edit" | "create" | "delete" | "verify" | "info";

export interface ThinkingStep {
  id:      string;
  kind:    ThinkingStepKind;
  text:    string;
  detail?: string;
  status?: "running" | "done" | "error";
  at:      number;
}

/* ── Kind meta — muted palette ─────────────────────────────── */
const KIND_META: Record<ThinkingStepKind, { hex: string; label: string }> = {
  route:       { hex: "#e07a45", label: "route"   },
  explore:     { hex: "#4bafc8", label: "read"    },
  file_loaded: { hex: "#8878c4", label: "load"    },
  plan:        { hex: "#b06ac8", label: "plan"    },
  edit:        { hex: "#4a90c8", label: "edit"    },
  create:      { hex: "#3aaa74", label: "create"  },
  delete:      { hex: "#c84a5a", label: "delete"  },
  verify:      { hex: "#5aaa3a", label: "verify"  },
  info:        { hex: "#b09040", label: "note"    },
};

/* ── Helpers ───────────────────────────────────────────────── */
function fmtMs(ms: number) {
  if (ms < 1000)  return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60)     return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function splitPath(p: string) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? { dir: p.slice(0, i + 1), file: p.slice(i + 1) } : { dir: "", file: p };
}

function kindFromRaw(raw: string): ThinkingStepKind {
  const r = raw.toLowerCase();
  if (/rout/i.test(r))              return "route";
  if (/read|explor|scan/i.test(r))  return "explore";
  if (/plan/i.test(r))              return "plan";
  if (/create|add/i.test(r))        return "create";
  if (/delete|remov/i.test(r))      return "delete";
  if (/verif|test/i.test(r))        return "verify";
  if (/edit|patch|modif/i.test(r))  return "edit";
  return "info";
}

/* ── Small step dot ────────────────────────────────────────── */
function StepDot({ kind, isLive, isError, isAllDone }: {
  kind: ThinkingStepKind; isLive: boolean; isError: boolean; isAllDone: boolean;
}) {
  if (isLive) return (
    <motion.span
      className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full"
      animate={{ opacity: [0.45, 0.9, 0.45] }}
      transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
      style={{ background: "#ff8a3d" }}
    />
  );
  if (isError)   return <span className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: "#c84a5a", opacity: 0.7 }} />;
  if (isAllDone) return <span className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: "#3aaa74", opacity: 0.65 }} />;
  return (
    <span className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full"
      style={{ background: KIND_META[kind]?.hex ?? "#888", opacity: 0.5 }} />
  );
}

/* ── Single step row ───────────────────────────────────────── */
function StepRow({ step, prevAt, startedAt, isLive, isAllDone, expanded, onToggle }: {
  step:      ThinkingStep;
  prevAt:    number;
  startedAt: number;
  isLive:    boolean;
  isAllDone: boolean;
  expanded:  boolean;
  onToggle:  () => void;
}) {
  const meta    = KIND_META[step.kind] ?? KIND_META.info;
  const isError = step.status === "error";
  const deltaMs = step.at - prevAt;

  const paths = useMemo(() => {
    if (!step.detail) return [];
    return step.detail.split(",").map(s => s.trim()).filter(Boolean).map(splitPath);
  }, [step.detail]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      // No `layout` here: these rows only ever get appended, never reordered
      // or removed mid-list, so there's nothing for FLIP measurement to do
      // except occasionally shift a row mid-insert — the actual cause of
      // the "not stacked vertically" glitch. Plain block flow stacks fine
      // on its own without it.
      className="block w-full group/row"
    >
      <button
        type="button"
        onClick={step.detail ? onToggle : undefined}
        className={`flex w-full items-start gap-2.5 rounded-md px-1 py-1.5 text-left ${step.detail ? "hover:bg-white/[0.03] cursor-pointer" : "cursor-default"}`}
      >
        <StepDot kind={step.kind} isLive={isLive} isError={isError} isAllDone={isAllDone} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            {/* kind label */}
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-widest"
              style={{ color: meta.hex, opacity: 0.6 }}>
              {meta.label}
            </span>

            {/* main text */}
            {isLive ? (
              <motion.span
                animate={{ opacity: [0.6, 0.9, 0.6] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
                className="min-w-0 truncate text-[12px] text-white/75"
              >
                {step.text}
              </motion.span>
            ) : (
              <span className="min-w-0 truncate text-[12px]"
                style={{ color: isError ? "#c84a5a" : "rgba(255,255,255,0.48)" }}>
                {step.text}
              </span>
            )}

            {/* delta */}
            {!isLive && deltaMs > 150 && (
              <span className="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-white/18">
                +{fmtMs(deltaMs)}
              </span>
            )}

            {/* expand chevron */}
            {step.detail && (
              <motion.span
                animate={{ rotate: expanded ? 90 : 0 }}
                transition={{ duration: 0.15 }}
                className="ml-1 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-60"
              >
                <ChevronRight className="h-2.5 w-2.5 text-white/40" />
              </motion.span>
            )}
          </div>

          {/* file path (collapsed preview) */}
          {!expanded && paths.length > 0 && (
            <p className="mt-0.5 font-mono text-[10px]">
              <span className="text-white/20">{paths[0].dir}</span>
              <span className="text-white/38">{paths[0].file}</span>
              {paths.length > 1 && <span className="ml-1 text-white/20">+{paths.length - 1}</span>}
            </p>
          )}
        </div>
      </button>

      {/* Expanded detail */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mb-1 ml-[22px] rounded-lg border border-white/[0.055] bg-white/[0.025] px-3 py-2">
              <div className="mb-1.5 flex items-center gap-3">
                <span className="text-[9px] font-semibold uppercase tracking-widest" style={{ color: meta.hex, opacity: 0.65 }}>
                  {meta.label}
                </span>
                <span className="font-mono text-[9.5px] text-white/25 tabular-nums">
                  +{fmtMs(deltaMs)} · T+{fmtMs(step.at - startedAt)}
                </span>
                {isError && <span className="text-[9.5px] text-[#c84a5a]">failed</span>}
              </div>

              <p className="text-[11.5px] leading-relaxed text-white/55">{step.text}</p>

              {paths.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {paths.map(({ dir, file }, i) => (
                    <p key={i} className="font-mono text-[10.5px]">
                      <span className="text-white/22">{dir}</span>
                      <span className="text-white/52">{file}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ── Reasoning log ─────────────────────────────────────────── */
function ReasoningLog({ log }: { log: LogEntry[] }) {
  const [open, setOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && endRef.current) endRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open, log.length]);

  if (log.length === 0) return null;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-white/[0.025]"
      >
        <TerminalSquare className="h-2.5 w-2.5 shrink-0 text-white/22 group-hover:text-white/40" />
        <span className="text-[10.5px] text-white/30 group-hover:text-white/50">
          Full reasoning log
        </span>
        <span className="font-mono text-[9px] text-white/18">{log.length}</span>
        <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: 0.15 }} className="ml-auto">
          <ChevronDown className="h-2.5 w-2.5 text-white/18 group-hover:text-white/35" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-1 max-h-[240px] overflow-y-auto rounded-lg border border-white/[0.05] bg-black/40 p-2.5 font-mono text-[10.5px]">
              {log.map((entry, i) => {
                const meta   = KIND_META[kindFromRaw(entry.kind)] ?? KIND_META.info;
                const prevAt = i > 0 ? log[i - 1].at : entry.at;
                const delta  = entry.at - prevAt;

                return (
                  <div key={entry.id} className="flex items-start gap-2 border-b border-white/[0.03] py-1.5 last:border-0">
                    <span className="mt-px shrink-0 rounded px-1 py-px text-[8.5px] font-semibold uppercase tracking-wider"
                      style={{ background: `${meta.hex}15`, color: meta.hex }}>
                      {entry.kind.slice(0, 8)}
                    </span>
                    <span className="min-w-0 flex-1 break-words leading-relaxed text-white/45">{entry.text}</span>
                    {delta > 50 && <span className="shrink-0 text-white/18">+{fmtMs(delta)}</span>}
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────── */
export default function ThinkingTrace({
  steps, log = [], isActive, startedAt,
}: {
  steps: ThinkingStep[]; log?: LogEntry[]; isActive: boolean; startedAt: number | null;
}) {
  const [expanded, setExpanded]         = useState(true);
  const [elapsed, setElapsed]           = useState(0);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isActive || !startedAt) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(id);
  }, [isActive, startedAt]);

  useEffect(() => {
    if (!isActive && startedAt) {
      const t = setTimeout(() => setExpanded(false), 800);
      return () => clearTimeout(t);
    }
  }, [isActive, startedAt]);

  useEffect(() => {
    if (expanded && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [steps.length, expanded]);

  const totalMs = useMemo(() => {
    if (!startedAt) return 0;
    if (isActive)   return elapsed;
    const last = steps[steps.length - 1]?.at ?? startedAt;
    return Math.max(elapsed, last - startedAt);
  }, [steps, isActive, elapsed, startedAt]);

  if (steps.length === 0 && !isActive) return null;

  const lastIndex = steps.length - 1;
  const lastStep  = steps[lastIndex];

  return (
    <div className="mb-3 select-none">

      {/* ── Header ── */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="group flex w-full items-center gap-2 rounded-md py-0.5 text-left"
      >
        {/* Indicator */}
        {isActive ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <motion.span className="absolute inset-0 rounded-full"
              animate={{ scale: [1, 2, 1], opacity: [0.4, 0, 0.4] }}
              transition={{ repeat: Infinity, duration: 1.5, ease: "easeOut" }}
              style={{ background: "rgba(255,138,61,0.7)" }} />
            <span className="relative h-full w-full rounded-full"
              style={{ background: "linear-gradient(135deg,#ff9b5f,#ff5a45)" }} />
          </span>
        ) : (
          <Check className="h-2.5 w-2.5 shrink-0 text-white/30" strokeWidth={2.5} />
        )}

        {/* Label */}
        <span className="text-[12px] font-medium">
          {isActive ? (
            <motion.span
              animate={{ opacity: [0.6, 1, 0.6] }}
              transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
              className="text-white/65"
            >
              Thinking
            </motion.span>
          ) : (
            <span className="text-white/38">
              Thought for <span className="font-mono tabular-nums">{fmtMs(totalMs)}</span>
            </span>
          )}
        </span>

        {/* Step count */}
        {steps.length > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-white/22">
            {steps.length} step{steps.length !== 1 ? "s" : ""}
          </span>
        )}

        {isActive && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-white/25">
            {fmtMs(elapsed)}
          </span>
        )}

        <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={{ duration: 0.18 }}
          className={isActive ? "" : "ml-auto"}>
          <ChevronDown className="h-3 w-3 text-white/18 group-hover:text-white/35" />
        </motion.span>
      </button>

      {/* Collapsed subtitle */}
      <AnimatePresence>
        {isActive && !expanded && lastStep && (
          <motion.p
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="mt-0.5 truncate pl-4 text-[10.5px] text-white/30"
          >
            <span style={{ color: KIND_META[lastStep.kind]?.hex, opacity: 0.6 }}>
              {KIND_META[lastStep.kind]?.label}
            </span>
            {" "}
            {lastStep.text}
          </motion.p>
        )}
      </AnimatePresence>

      {/* ── Expanded body ── */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="relative mt-2 pl-0.5">
              {/* Guide line */}
              <div className="pointer-events-none absolute bottom-0 left-[9px] top-0 w-px bg-white/[0.05]" />

              <div ref={scrollRef} className="max-h-[320px] overflow-y-auto pr-1">
                <AnimatePresence initial={false}>
                  {steps.map((step, idx) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      prevAt={idx > 0 ? steps[idx - 1].at : (startedAt ?? step.at)}
                      startedAt={startedAt ?? step.at}
                      isLive={isActive && idx === lastIndex}
                      isAllDone={!isActive}
                      expanded={expandedStep === step.id}
                      onToggle={() => setExpandedStep(p => p === step.id ? null : step.id)}
                    />
                  ))}
                </AnimatePresence>

                {isActive && steps.length === 0 && (
                  <div className="flex items-center gap-2 px-1 py-1.5">
                    <Loader2 className="h-3 w-3 animate-spin text-white/20" />
                    <span className="text-[11px] text-white/28">Starting...</span>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            {!isActive && steps.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}
                className="mt-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/[0.04]" />
                <span className="font-mono text-[9px] text-white/20">{steps.length} steps · {fmtMs(totalMs)}</span>
                <div className="h-px flex-1 bg-white/[0.04]" />
              </motion.div>
            )}

            <ReasoningLog log={log} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
