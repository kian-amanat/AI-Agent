"use client";

import { motion } from "framer-motion";
import { Check, FilePen, FilePlus, FileX, X } from "lucide-react";
import type { PlanStep } from "../../lib/api";

const ACTION_CFG = {
  edit:      { label: "Edit",   Icon: FilePen,   color: "#ff9b5f" },
  create:    { label: "Create", Icon: FilePlus,  color: "#34d399" },
  delete:    { label: "Delete", Icon: FileX,     color: "#fb7185" },
  read_only: { label: "Read",   Icon: FilePen,   color: "#94a3b8" },
} as const;

export default function PlanPreviewPanel({
  steps,
  onApprove,
  onCancel,
  isApproving,
}: {
  steps:       PlanStep[];
  onApprove:   () => void;
  onCancel:    () => void;
  isApproving: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="my-3 overflow-hidden rounded-2xl border border-[#ff8a3d]/20 bg-[#141414]"
      style={{ boxShadow: "0 0 32px rgba(255,138,61,0.08)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-white/[0.06] px-4 py-3"
           style={{ background: "rgba(255,138,61,0.05)" }}>
        <span className="h-[6px] w-[6px] rounded-full bg-[#ff8a3d]" />
        <span className="text-sm font-semibold text-white/85">Plan Preview</span>
        <span className="ml-auto text-[11px] text-white/35">
          {steps.length} change{steps.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Steps list */}
      <div className="max-h-56 overflow-y-auto">
        {steps.map((step, i) => {
          const cfg = ACTION_CFG[step.action as keyof typeof ACTION_CFG] ?? ACTION_CFG.edit;
          const { Icon } = cfg;
          const lastSlash = step.path.lastIndexOf("/");
          const dir  = lastSlash >= 0 ? step.path.slice(0, lastSlash + 1) : "";
          const file = lastSlash >= 0 ? step.path.slice(lastSlash + 1) : step.path;

          return (
            <div key={i} className="flex items-start gap-3 border-b border-white/[0.04] px-4 py-2.5 last:border-0">
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.03]">
                <Icon className="h-3 w-3" style={{ color: cfg.color }} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1 font-mono text-[11px]">
                  {dir && <span className="text-white/28">{dir}</span>}
                  <span className="font-medium text-white/75">{file}</span>
                  <span className="ml-1 shrink-0 text-[10px]" style={{ color: cfg.color }}>
                    {cfg.label}
                  </span>
                </div>
                {step.description && (
                  <p className="mt-0.5 truncate text-[11px] text-white/35">{step.description}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <p className="mr-auto text-[11px] text-white/35">
          Review the plan above, then approve or cancel.
        </p>
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={onCancel}
          disabled={isApproving}
          className="flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={onApprove}
          disabled={isApproving}
          className="flex items-center gap-1.5 rounded-xl border border-[#ff8a3d]/25 bg-[#ff8a3d]/10 px-3 py-1.5 text-xs font-medium text-[#ff8a3d] transition-colors hover:bg-[#ff8a3d]/18 disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" />
          {isApproving ? "Applying…" : "Apply Changes"}
        </motion.button>
      </div>
    </motion.div>
  );
}
