import React from "react";
import { RotateCcw, Loader2, Check } from "lucide-react";

type ParsedSection = {
  type: "text" | "bullet" | "numbered" | "code" | "header" | "divider";
  content: string;
  language?: string;
};

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
  // هر فیلد دیگری که قبلاً داشتی هم می‌تواند اینجا اضافه شود
}

function parseAssistantContent(content: string) {
  const sections: ParsedSection[] = [];
  const lines = content.split("\n");
  let currentSection: ParsedSection | null = null;
  let inCodeBlock = false;
  let codeLanguage = "";

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
if (!inCodeBlock) {
if (currentSection) sections.push(currentSection);
codeLanguage = line.trim().replace(/```/g, "").trim();
        currentSection = { type: "code", content: "", language: codeLanguage };
        inCodeBlock = true;
      } else {
        if (currentSection) sections.push(currentSection);
        currentSection = null;
        inCodeBlock = false;
        codeLanguage = "";
      }
      return;
    }

    if (inCodeBlock && currentSection) {
      currentSection.content += (currentSection.content ? "\n" : "") + line;
      return;
    }

    if (line.match(/^[\s]*[•\-*]\s+/)) {
      if (currentSection?.type !== "bullet") {
        if (currentSection) sections.push(currentSection);
        currentSection = { type: "bullet", content: line };
      } else {
        currentSection.content += "\n" + line;
      }
      return;
    }

    if (line.match(/^[\s]*\d+\.\s+/)) {
      if (currentSection?.type !== "numbered") {
        if (currentSection) sections.push(currentSection);
        currentSection = { type: "numbered", content: line };
      } else {
        currentSection.content += "\n" + line;
      }
      return;
    }

    if (line.trim().match(/^#{1,6}\s+/)) {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: "header", content: line };
      sections.push(currentSection);
      currentSection = null;
      return;
    }

    if (line.trim().match(/^[-_]{3,}$/) && !line.includes("*")) {
      if (currentSection) sections.push(currentSection);
      sections.push({ type: "divider", content: "" });
      currentSection = null;
      return;
    }

    if (line.trim() === "") {
      if (currentSection?.type === "text" && currentSection.content.trim()) {
        sections.push(currentSection);
        currentSection = null;
      }
      return;
    }

    if (currentSection?.type === "text") {
      currentSection.content += "\n" + line;
    } else {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: "text", content: line };
    }
  });

  if (currentSection) sections.push(currentSection);
  return sections.filter((s) => s.content?.trim() || s.type === "divider");
}

type AssistantMessageProps = {
  content: string;
  metadata?: AssistantMessageMetadata;
  /** وقتی روی دکمه Undo کلیک می‌شود */
  onUndoClick?: () => void;
  /** آیا الان در حال اجرای Undo برای این پیام هستیم؟ */
  isUndoing?: boolean;
};

export default function AssistantMessage({
  content,
  metadata,
  onUndoClick,
  isUndoing,
}: AssistantMessageProps) {
  const sections = parseAssistantContent(content);
  const canShowUndo =
    metadata?.intent === "technical" && !!metadata?.requestId && !!onUndoClick;

  const undoResult = metadata?.undoResult;

  // حالت موفقیت دائمی بعد از اتمام Undo (تا وقتی metadata عوض نشه)
  const [undoSucceeded, setUndoSucceeded] = React.useState(false);

  React.useEffect(() => {
    if (undoResult && !undoResult.error) {
      setUndoSucceeded(true);
    }
  }, [undoResult]);

  return (
    <div className="space-y-3">
      {sections.map((section, idx) => {
        if (section.type === "bullet") {
          const items = section.content.split("\n").filter((l) => l.trim());
          return (
            <ul key={idx} className="space-y-2">
              {items.map((item, i) => {
                let cleanText = item.trim();
                cleanText = cleanText.replace(
                  /^[•\-*✓✗→◦▪▫■□●○◆◇★☆]+\s*/g,
                  "",
                );
                cleanText = cleanText.replace(/^\*+\s*/g, "");
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, "$1");
                cleanText = cleanText.trim();
                if (!cleanText) return null;

                return (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-1 text-white/30">•</span>
                    <span className="flex-1 text-[15px] leading-7 text-white/84">
                      {cleanText}
                    </span>
                  </li>
                );
              })}
            </ul>
          );
        }

        if (section.type === "numbered") {
          const items = section.content.split("\n").filter((l) => l.trim());
          return (
            <ol key={idx} className="space-y-2">
              {items.map((item, i) => {
                let cleanText = item.trim();
                cleanText = cleanText.replace(/^[\s]*\d+\.[\s]*/, "");
                cleanText = cleanText.replace(/^\*\*([^*]+)\*\*/, "$1");
                cleanText = cleanText.trim();
                if (!cleanText) return null;

                return (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="min-w-[24px] text-sm font-medium text-white/42">
                      {i + 1}.
                    </span>
                    <span className="flex-1 text-[15px] leading-7 text-white/84">
                      {cleanText}
                    </span>
                  </li>
                );
              })}
            </ol>
          );
        }

        if (section.type === "code") {
          return (
            <div
              key={idx}
              className="overflow-x-auto rounded-2xl border border-white/10 bg-[#0f0f0f] p-4 shadow-inner"
            >
              {section.language && (
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/35">
                  {section.language}
                </div>
              )}
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-white/88">
                {section.content}
              </pre>
            </div>
          );
        }

        if (section.type === "header") {
          const level = (section.content.match(/^#+/) || [""])[0].length;
          const text = section.content.replace(/^#+\s*/, "");
          const sizes = ["text-xl", "text-lg", "text-base", "text-base"];
          return (
            <h3
              key={idx}
              className={`${
                sizes[level - 1] || "text-base"
              } mb-1.5 mt-3 font-semibold text-white`}
            >
              {text}
            </h3>
          );
        }

        if (section.type === "divider") {
          return (
            <div
              key={idx}
              className="my-4 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
            />
          );
        }

        if (section.content.trim()) {
          return (
            <p
              key={idx}
              className="whitespace-pre-wrap text-[15px] leading-7 text-white/84"
            >
              {section.content}
            </p>
          );
        }

        return null;
      })}

      {/* دکمه Undo برای پیام‌های technical با requestId */}
      {canShowUndo && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onUndoClick}
            disabled={isUndoing || undoSucceeded}
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
              // ترنزیشن نرم برای رنگ، بوردِر، سایه و scale
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
