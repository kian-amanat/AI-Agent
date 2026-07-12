"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import type { FileDiff, DiffHunk } from "../../lib/api";

const ACTION_CFG = {
  create: { label: "created", accent: "#34d399", tint: "rgba(52,211,153,0.09)" },
  edit:   { label: "edited",  accent: "#ff9b5f", tint: "rgba(255,155,95,0.09)" },
  delete: { label: "deleted", accent: "#fb7185", tint: "rgba(251,113,133,0.09)" },
} as const;

function Lines({
  text,
  variant,
  startLine = 1,
}: {
  text:       string;
  variant:    "add" | "remove" | "ctx";
  startLine?: number;
}) {
  const lines     = text.split("\n");
  const prefix    = variant === "add" ? "+" : variant === "remove" ? "−" : " ";
  const rowBg     = variant === "add" ? "rgba(52,211,153,0.07)" : variant === "remove" ? "rgba(251,113,133,0.06)" : "transparent";
  const textColor = variant === "add" ? "rgba(134,239,172,0.88)" : variant === "remove" ? "rgba(252,165,165,0.65)" : "rgba(255,255,255,0.3)";
  const prefixClr = variant === "add" ? "#34d399" : variant === "remove" ? "#fb7185" : "rgba(255,255,255,0.15)";
  const lineNumClr = "rgba(255,255,255,0.12)";

  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="flex items-start" style={{ background: rowBg }}>
          {/* line number */}
          <span
            className="select-none w-8 shrink-0 text-right pr-2 py-[2px] font-mono text-[10px] leading-5 tabular-nums"
            style={{ color: lineNumClr }}
          >
            {startLine + i}
          </span>
          {/* +/- prefix */}
          <span
            className="select-none w-4 shrink-0 text-center py-[2px] font-mono text-[11px] leading-5"
            style={{ color: prefixClr }}
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
  const [open, setOpen] = useState(true);
  const beforeLines = hunk.before?.split("\n").length ?? 0;
  const afterLines  = hunk.after?.split("\n").length ?? 0;

  return (
    <div>
      {total > 1 && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-[3px] font-mono text-[10px] tracking-widest select-none hover:bg-white/[0.02] transition-colors"
          style={{ color: "rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.02)" }}
        >
          {open
            ? <ChevronDown  className="h-2.5 w-2.5" />
            : <ChevronRight className="h-2.5 w-2.5" />
          }
          @@ hunk {idx + 1}/{total} · {beforeLines + afterLines} lines
        </button>
      )}

      {open && (
        <>
          {hunk.kind === "create" && hunk.after != null && (
            <Lines text={hunk.after} variant="add" startLine={1} />
          )}

          {hunk.kind === "delete" && hunk.before != null && (
            <Lines text={hunk.before} variant="remove" startLine={1} />
          )}

          {(hunk.kind === "replace" || hunk.kind === "rewrite") && (
            <>
              {hunk.before != null && <Lines text={hunk.before} variant="remove" startLine={1} />}
              {hunk.after  != null && <Lines text={hunk.after}  variant="add"    startLine={1} />}
            </>
          )}

          {hunk.kind === "insert" && (
            <>
              {hunk.anchor && (
                <div
                  className="px-3 py-[2px] font-mono text-[10.5px] truncate select-none"
                  style={{ color: "rgba(255,255,255,0.18)" }}
                >
                  ↓ after: {hunk.anchor.slice(0, 72)}{hunk.anchor.length > 72 ? "…" : ""}
                </div>
              )}
              {hunk.after != null && <Lines text={hunk.after} variant="add" startLine={1} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function FileDiffView({ diff }: { diff: FileDiff }) {
  const [open,   setOpen]   = useState(true);
  const [copied, setCopied] = useState(false);

  const cfg = ACTION_CFG[diff.action as keyof typeof ACTION_CFG] ?? ACTION_CFG.edit;

  const lastSlash = diff.path.lastIndexOf("/");
  const dir  = lastSlash >= 0 ? diff.path.slice(0, lastSlash + 1) : "";
  const file = lastSlash >= 0 ? diff.path.slice(lastSlash + 1)  : diff.path;

  const totalLines = diff.hunks.reduce(
    (n, h) => n + (h.after?.split("\n").length ?? 0) + (h.before?.split("\n").length ?? 0),
    0,
  );

  const addedLines   = diff.hunks.reduce((n, h) => n + (h.after?.split("\n").length  ?? 0), 0);
  const removedLines = diff.hunks.reduce((n, h) => n + (h.before?.split("\n").length ?? 0), 0);

  async function handleCopy() {
    const text = diff.hunks.map((h) => [h.before, h.after].filter(Boolean).join("\n")).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return (
    <div
      className="rounded-2xl overflow-hidden my-1.5"
      style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      {/* Header */}
      <div className="w-full flex items-center gap-2 px-3 py-2 text-left" style={{ background: cfg.tint }}>
        <button onClick={() => setOpen((v) => !v)} className="flex flex-1 items-center gap-2 min-w-0">
          <span className="h-[6px] w-[6px] rounded-full shrink-0" style={{ background: cfg.accent }} />

          <span className="font-mono text-[11px] min-w-0 flex-1 flex items-baseline gap-0.5 truncate">
            {dir && <span style={{ color: "rgba(255,255,255,0.3)" }}>{dir}</span>}
            <span style={{ color: "rgba(255,255,255,0.75)", fontWeight: 500 }}>{file}</span>
          </span>

          <span className="text-[10px] font-medium shrink-0" style={{ color: cfg.accent }}>
            {cfg.label}
          </span>

          {diff.language && (
            <span className="font-mono text-[10px] shrink-0 hidden sm:block" style={{ color: "rgba(255,255,255,0.2)" }}>
              {diff.language}
            </span>
          )}

          {/* +/- line counts */}
          <span className="font-mono text-[10px] tabular-nums shrink-0 hidden sm:block" style={{ color: "rgba(52,211,153,0.6)" }}>
            +{addedLines}
          </span>
          <span className="font-mono text-[10px] tabular-nums shrink-0 hidden sm:block" style={{ color: "rgba(251,113,133,0.6)" }}>
            -{removedLines}
          </span>
          <span className="font-mono text-[10px] tabular-nums shrink-0" style={{ color: "rgba(255,255,255,0.2)" }}>
            {totalLines}L
          </span>

          {open
            ? <ChevronDown  className="h-3 w-3 shrink-0" style={{ color: "rgba(255,255,255,0.2)" }} />
            : <ChevronRight className="h-3 w-3 shrink-0" style={{ color: "rgba(255,255,255,0.2)" }} />
          }
        </button>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          title="Copy diff"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-white/[0.07] bg-white/[0.04] text-white/35 transition-colors hover:bg-white/[0.08] hover:text-white/70"
        >
          {copied
            ? <Check className="h-2.5 w-2.5 text-[#34d399]" />
            : <Copy  className="h-2.5 w-2.5" />
          }
        </button>
      </div>

      {/* Body */}
      {open && (
        <div
          className="border-t overflow-x-auto max-h-96 overflow-y-auto"
          style={{ borderColor: "rgba(255,255,255,0.05)" }}
        >
          {diff.hunks.length === 0 ? (
            <div className="px-4 py-3 font-mono text-[12px]" style={{ color: "rgba(255,255,255,0.2)" }}>
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
