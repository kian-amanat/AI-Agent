"use client";

import React from "react";
import { Check, Copy } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

// Maps a fenced code block's info-string language (e.g. "tsx", "py") to the
// display name shown in the header pill — matching how Claude Code labels
// its own code blocks (full names, not raw file extensions).
const LANGUAGE_LABELS: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
  mjs: "JavaScript", cjs: "JavaScript", py: "Python", python: "Python",
  sh: "Bash", bash: "Bash", shell: "Bash", zsh: "Bash",
  json: "JSON", yaml: "YAML", yml: "YAML", css: "CSS", scss: "SCSS",
  html: "HTML", xml: "XML", md: "Markdown", markdown: "Markdown",
  sql: "SQL", go: "Go", rs: "Rust", rust: "Rust", java: "Java",
  c: "C", cpp: "C++", "c++": "C++", rb: "Ruby", ruby: "Ruby",
  php: "PHP", swift: "Swift", kt: "Kotlin", kotlin: "Kotlin",
  dockerfile: "Dockerfile", diff: "Diff", toml: "TOML", txt: "Plain text",
};

function displayLanguage(lang: string) {
  if (!lang) return "Plain text";
  return LANGUAGE_LABELS[lang.toLowerCase()] || lang;
}

// Prism's stock theme ships its own background/margins meant for a standalone
// block — stripped here so the code sits flush inside our own header+card
// chrome instead of nesting two competing frames.
const highlighterStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px 16px",
  background: "transparent",
  fontSize: "13px",
  lineHeight: 1.65,
};

const codeTagProps = {
  style: {
    fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
  },
};

export default function CodeBlock({ language = "", code }: { language?: string; code: string }) {
  const [copied, setCopied] = React.useState(false);
  const content = code.replace(/\n$/, "");

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/10 bg-[#0d0d0f]">
      {/* Header: language name (left) + Copy (right) — same chrome Claude Code uses */}
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3.5 py-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
          {displayLanguage(language)}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/80"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Body */}
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={language || "text"}
          style={oneDark}
          customStyle={highlighterStyle}
          codeTagProps={codeTagProps}
          wrapLongLines={false}
        >
          {content}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
