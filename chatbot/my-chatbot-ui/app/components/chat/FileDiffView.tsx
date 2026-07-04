"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FileDiff, DiffHunk } from "../../lib/api";

const ACTION_CFG = {
  create: { label: "created", accent: "#34d399", tint: "rgba(52,211,153,0.09)" },
  edit:   { label: "edited",  accent: "#ff9b5f", tint: "rgba(255,155,95,0.09)" },
  delete: { label: "deleted", accent: "#fb7185", tint: "rgba(251,113,133,0.09)" },
} as const;

function Lines({ text, variant }: { text: string; variant: "add" | "remove" | "ctx" }) {
  const lines = text.split("\n");
  const prefix = variant === "add" ? "+" : variant === "remove" ? "−" : " ";

  const rowBg =
    variant === "add" ? "rgba(52,211,153,0.07)" :
    variant === "remove" ? "rgba(251,113,133,0.06)" :
    "transparent";

  const textColor =
    variant === "add" ? "rgba(134,239,172,0.88)" :
    variant === "remove" ? "rgba(252,165,165,0.65)" :
    "rgba(255,255,255,0.3)";

  const prefixColor =
    variant === "add" ? "#34d399" :
    variant === "remove" ? "#fb7185" :
    "rgba(255,255,255,0.15)";

  return (
    <>
      {lines.map((line, i) => (
        <div
          key={i}
          className="flex items-start"
          style={{ background: rowBg }}
        >
          <span
            className="select-none w-5 shrink-0 text-center text-[11px] leading-5 py-[2px] font-mono"
            style={{ color: prefixColor }}
          >
            {prefix}
          </span>
          <span
            className="flex-1 py-[2px] pr-3 font-mono text-[12px] leading-5 whitespace-pre break-all"
            style={{ color: textColor }}
          >
            {line || " "}
          </span>
        </div>
      ))}
    </>
  );
}

function Hunk({ hunk, idx, total }: { hunk: DiffHunk; idx: number; total: number }) {
  return (
    <div>
      {total > 1 && (
        <div
          className="px-3 py-[3px] font-mono text-[10px] tracking-widest select-none"
          style={{ color: "rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.02)" }}
        >
          @@ {idx + 1}/{total}
        </div>
      )}

      {hunk.kind === "create" && hunk.after != null && (
        <Lines text={hunk.after} variant="add" />
      )}

      {hunk.kind === "delete" && hunk.before != null && (
        <Lines text={hunk.before} variant="remove" />
      )}

      {(hunk.kind === "replace" || hunk.kind === "rewrite") && (
        <>
          {hunk.before != null && <Lines text={hunk.before} variant="remove" />}
          {hunk.after  != null && <Lines text={hunk.after}  variant="add"    />}
        </>
      )}

      {hunk.kind === "insert" && (
        <>
          {hunk.anchor && (
            <div
              className="px-3 py-[2px] font-mono text-[10.5px] truncate select-none"
              style={{ color: "rgba(255,255,255,0.2)" }}
            >
              ↓ {hunk.anchor.slice(0, 60)}{hunk.anchor.length > 60 ? "…" : ""}
            </div>
          )}
          {hunk.after != null && <Lines text={hunk.after} variant="add" />}
        </>
      )}
    </div>
  );
}

export default function FileDiffView({ diff }: { diff: FileDiff }) {
  const [open, setOpen] = useState(true);

  const cfg = ACTION_CFG[diff.action as keyof typeof ACTION_CFG] ?? ACTION_CFG.edit;

  const lastSlash = diff.path.lastIndexOf("/");
  const dir  = lastSlash >= 0 ? diff.path.slice(0, lastSlash + 1) : "";
  const file = lastSlash >= 0 ? diff.path.slice(lastSlash + 1) : diff.path;

  const totalLines = diff.hunks.reduce(
    (n, h) => n + (h.after?.split("\n").length ?? 0) + (h.before?.split("\n").length ?? 0),
    0,
  );

  return (
    <div
      className="rounded-2xl overflow-hidden my-1.5"
      style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        style={{ background: cfg.tint }}
      >
        <span
          className="h-[6px] w-[6px] rounded-full shrink-0"
          style={{ background: cfg.accent }}
        />

        <span className="font-mono text-[11px] min-w-0 flex-1 flex items-baseline gap-0.5 truncate">
          {dir && (
            <span style={{ color: "rgba(255,255,255,0.3)" }}>{dir}</span>
          )}
          <span style={{ color: "rgba(255,255,255,0.75)", fontWeight: 500 }}>{file}</span>
        </span>

        <span
          className="text-[10px] font-medium shrink-0"
          style={{ color: cfg.accent }}
        >
          {cfg.label}
        </span>

        {diff.language && (
          <span
            className="font-mono text-[10px] shrink-0 hidden sm:block"
            style={{ color: "rgba(255,255,255,0.2)" }}
          >
            {diff.language}
          </span>
        )}

        <span
          className="font-mono text-[10px] tabular-nums shrink-0"
          style={{ color: "rgba(255,255,255,0.2)" }}
        >
          {totalLines}L
        </span>

        {open
          ? <ChevronDown  className="h-3 w-3 shrink-0" style={{ color: "rgba(255,255,255,0.2)" }} />
          : <ChevronRight className="h-3 w-3 shrink-0" style={{ color: "rgba(255,255,255,0.2)" }} />
        }
      </button>

      {/* Body */}
      {open && (
        <div
          className="border-t overflow-x-auto max-h-64 overflow-y-auto"
          style={{ borderColor: "rgba(255,255,255,0.05)" }}
        >
          {diff.hunks.length === 0 ? (
            <div
              className="px-4 py-3 font-mono text-[12px]"
              style={{ color: "rgba(255,255,255,0.2)" }}
            >
              no diff
            </div>
          ) : (
            diff.hunks.map((h, i) => (
              <Hunk key={i} hunk={h} idx={i} total={diff.hunks.length} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
