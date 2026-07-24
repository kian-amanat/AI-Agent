import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { RotateCcw, Loader2, Check } from "lucide-react";
import CodeBlock from "./CodeBlock";
import FileDiffView from "./FileDiffView";
import type { FileDiff } from "../../lib/api";

export interface UndoStats {
  filesTouched: number;
  filesReverted: number;
  errors: number;
}

export interface UndoResult {
  stats?: UndoStats;
  files?: Array<{
    path: string;
    status: "reverted" | "skipped" | "error";
    reason?: string;
  }>;
  error?: string;
}

export interface AssistantMessageMetadata {
  type?: string;
  intent?: string;
  requestId?: string;
  undoResult?: UndoResult;
  fileDiffs?: FileDiff[];
}

// Real GFM markdown rendering (tables, inline code, bold/italic, autolinks)
// via react-markdown, instead of a hand-rolled line-by-line parser — that
// parser had no table support at all, which is why a response containing a
// markdown table rendered as raw "| a | b |" text instead of an actual table.
const markdownComponents: Components = {
  h1: ({ children }) => <h2 className="mb-2 mt-4 text-xl font-semibold text-white first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="mb-1.5 mt-3.5 text-lg font-semibold text-white first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-3 text-base font-semibold text-white first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mb-1 mt-2.5 text-base font-semibold text-white/90 first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mb-1 mt-2 text-sm font-semibold text-white/90 first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mb-1 mt-2 text-sm font-semibold text-white/80 first:mt-0">{children}</h6>,

  p: ({ children }) => (
    <p className="whitespace-pre-wrap text-[14px] leading-6 text-white/84 [&:not(:first-child)]:mt-3">
      {children}
    </p>
  ),

  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic text-white/90">{children}</em>,
  del: ({ children }) => <del className="text-white/50 line-through">{children}</del>,

  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#ff8a3d] underline decoration-[#ff8a3d]/30 underline-offset-2 transition-colors hover:decoration-[#ff8a3d]/70"
    >
      {children}
    </a>
  ),

  // Native browser markers (Tailwind's preflight strips list-style by
  // default) restored via list-disc/list-decimal + the marker: variant to
  // color them — simpler and more correct than faking numbering by hand,
  // since react-markdown doesn't hand `li` an index to do that with.
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1.5 pl-5 marker:text-white/30">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1.5 pl-5 marker:text-white/42 marker:font-medium">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="text-[14px] leading-6 text-white/84 [&_p]:m-0 [&_p]:inline">{children}</li>
  ),

  hr: () => <div className="my-4 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />,

  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-white/15 pl-3 text-white/60 italic">
      {children}
    </blockquote>
  ),

  // Tables — this is the exact fix for the raw "| Element | Before | After |"
  // rendering seen when the parser had no table support.
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full border-collapse text-left text-[13.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.04]">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-white/[0.06]">{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-white/10 px-3 py-2 font-semibold text-white/70">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-3 py-2 align-top text-white/78">{children}</td>,

  // Inline code vs fenced code block: react-markdown v9+ no longer passes an
  // `inline` flag, so distinguish by the presence of a `language-*` className
  // (only set on fenced ```blocks, never on inline `code` spans).
  code(props) {
    const { className, children } = props;
    const match = /language-(\w+)/.exec(className || "");
    const text = Array.isArray(children) ? children.join("") : String(children ?? "");
    if (match) {
      return <CodeBlock language={match[1]} code={text} />;
    }
    return (
      <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[13px] text-[#ffb787]">
        {children}
      </code>
    );
  },
  // Fenced blocks arrive as <pre><code>...</code></pre>; CodeBlock already
  // renders its own card chrome, so the outer <pre> just passes through.
  pre: ({ children }) => <>{children}</>,
};

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

type AssistantMessageProps = {
  content: string;
  metadata?: AssistantMessageMetadata;
  onUndoClick?: () => void;
  isUndoing?: boolean;
  timestamp?: string;
};

function AssistantMessage({
  content,
  metadata,
  onUndoClick,
  isUndoing,
  timestamp,
}: AssistantMessageProps) {
  const canShowUndo = !!metadata?.requestId && !!onUndoClick;
  const undoResult = metadata?.undoResult;

  const [undoSucceeded, setUndoSucceeded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Latch "succeeded" permanently true once undoResult first reports success,
  // and keep it that way even if a later metadata update clears undoResult.
  // Adjusted during render (React's documented pattern for "state that should
  // change when a prop changes") rather than in a useEffect — an effect here
  // would fire one render late and trigger react-hooks/set-state-in-effect.
  const prevUndoResultRef = React.useRef(undoResult);
  if (undoResult !== prevUndoResultRef.current) {
    prevUndoResultRef.current = undoResult;
    if (undoResult && !undoResult.error && !undoSucceeded) {
      setUndoSucceeded(true);
    }
  }

  return (
    <div className="space-y-3">
      {timestamp && (
        <div className="flex justify-end mb-1">
          <div className="relative group">
            <span className="text-[11px] text-white/30 cursor-help">
              {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-zinc-800 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
              {timestamp}
            </div>
          </div>
        </div>
      )}

      <AssistantMarkdown content={content} />

      {/* File diffs — shown after content, before undo button */}
      {metadata?.fileDiffs && metadata.fileDiffs.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {metadata.fileDiffs.map((diff, i) => (
            <FileDiffView key={i} diff={diff} />
          ))}
        </div>
      )}

      {/* Undo button */}
      {canShowUndo && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onUndoClick}
            disabled={isUndoing || undoSucceeded}
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
              "transition-all duration-300 ease-out",
              isUndoing
                ? "border border-amber-400/60 bg-amber-400/10 text-amber-50 shadow-[0_0_0_1px_rgba(251,191,36,0.25)] scale-[0.98]"
                : undoSucceeded
                ? "border border-emerald-400/80 bg-emerald-400/10 text-emerald-50 shadow-[0_0_18px_rgba(16,185,129,0.25)]"
                : "border border-white/14 bg-white/[0.02] text-white/80 hover:border-white/26 hover:bg-white/[0.06]",
              (isUndoing || undoSucceeded) && "cursor-default",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {isUndoing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Reverting changes…</span>
              </>
            ) : undoSucceeded ? (
              <>
                <Check className="h-3.5 w-3.5" />
                <span>Changes reverted</span>
              </>
            ) : (
              <>
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Undo file changes</span>
              </>
            )}
          </button>
        </div>
      )}

    </div>
  );
}

// Memoized: without this, every AssistantMessage re-parses its markdown on every
// parent render (i.e. on every streamed chunk of the ACTIVE message), which is
// what makes a long chat lag. With memo, only the message whose props actually
// changed re-renders.
export default React.memo(AssistantMessage);
