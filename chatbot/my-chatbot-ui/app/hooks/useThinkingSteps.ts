"use client";

import { useCallback, useRef, useState } from "react";
import type { SSEEvent } from "../lib/api";
import type { ThinkingStep, ThinkingStepKind } from "../components/chat/ThinkingTrace";

let _counter = 0;
const nextId = () => `ts_${Date.now()}_${_counter++}`;

export interface LogEntry {
  id:   string;
  kind: string;    // raw stage / action label
  text: string;    // human-readable raw text
  at:   number;
}

interface TraceState {
  steps:     ThinkingStep[];
  log:       LogEntry[];
  startedAt: number | null;
  isActive:  boolean;
}

const emptyTrace = (): TraceState => ({
  steps: [], log: [], startedAt: null, isActive: false,
});

export function useThinkingSteps() {
  const [traces, setTraces] = useState<Record<string, TraceState>>({});
  const activeMsgRef = useRef<string | null>(null);

  const begin = useCallback((messageId: string) => {
    activeMsgRef.current = messageId;
    setTraces(prev => ({
      ...prev,
      [messageId]: { steps: [], log: [], startedAt: Date.now(), isActive: true },
    }));
  }, []);

  const end = useCallback((messageId: string) => {
    setTraces(prev => {
      const t = prev[messageId];
      if (!t) return prev;
      return { ...prev, [messageId]: { ...t, isActive: false } };
    });
    activeMsgRef.current = null;
  }, []);

  const addStep = useCallback(
    (messageId: string, step: Omit<ThinkingStep, "id" | "at">) => {
      setTraces(prev => {
        const t = prev[messageId] || emptyTrace();
        const s: ThinkingStep = { ...step, id: nextId(), at: Date.now() };
        return {
          ...prev,
          [messageId]: {
            ...t,
            steps: [...t.steps, s],
            startedAt: t.startedAt ?? Date.now(),
            isActive: true,
          },
        };
      });
    },
    []
  );

  const addLog = useCallback(
    (messageId: string, entry: Omit<LogEntry, "id">) => {
      setTraces(prev => {
        const t = prev[messageId] || emptyTrace();
        return {
          ...prev,
          [messageId]: {
            ...t,
            log: [...t.log, { ...entry, id: nextId() }],
          },
        };
      });
    },
    []
  );

  const onSSEEvent = useCallback(
    (messageId: string, event: SSEEvent) => {
      const now = Date.now();

      switch (event.type) {
        case "start":
          begin(messageId);
          break;

        case "progress": {
          const stage = (event as any).stage || "";
          const msg   = (event as any).message || "";
          if (!msg) break;

          // Raw log entry (keep original emoji/text)
          addLog(messageId, { kind: stage || "info", text: msg, at: now });

          let kind: ThinkingStepKind = "info";
          if (/rout/i.test(stage))                  kind = "route";
          else if (/explor|scan|read/i.test(stage)) kind = "explore";
          else if (/plan/i.test(stage))             kind = "plan";
          else if (/exec|step|appl/i.test(stage))   kind = "edit";
          else if (/verif/i.test(stage))            kind = "verify";

          const clean = msg.replace(/^[\u{1F000}-\u{1FFFF}☀-➿\s]+/u, "").trim();
          addStep(messageId, { kind, text: clean || msg });
          break;
        }

        case "file_context": {
          const files = ((event as any).files as { path: string }[]) || [];
          if (!files.length) break;

          // One log entry per file
          files.forEach(f =>
            addLog(messageId, { kind: "reading", text: f.path, at: now })
          );

          addStep(messageId, {
            kind: "explore",
            text: `Loaded ${files.length} file${files.length !== 1 ? "s" : ""}`,
            detail: files.map(f => f.path).join(", "),
          });
          break;
        }

        case "plan": {
          const planSteps = (event as any).steps || [];
          const reasoning = (event as any).reasoning || "";

          if (reasoning) {
            addLog(messageId, { kind: "planning", text: reasoning, at: now });
            addStep(messageId, { kind: "plan", text: reasoning });
          }

          for (const s of planSteps) {
            const action   = (s.action || "").toLowerCase();
            const fileName = s.path ? s.path.split("/").pop() : "";

            let kind: ThinkingStepKind = "edit";
            if (action === "create")    kind = "create";
            else if (action === "delete") kind = "delete";
            else if (action === "read_only") kind = "info";

            addLog(messageId, { kind: action || "edit", text: `${action} ${s.path || ""}`.trim(), at: now });
            addStep(messageId, {
              kind,
              text: s.description || `${action} ${fileName}`,
              detail: s.path,
            });
          }
          break;
        }

        case "file_change": {
          const action   = ((event as any).action || "").toLowerCase();
          const path     = (event as any).path || "";
          const ok       = (event as any).success;
          const error    = (event as any).error;
          const fileName = path.split("/").pop();

          let kind: ThinkingStepKind = "edit";
          if (action === "create") kind = "create";
          else if (action === "delete") kind = "delete";

          const label = ok
            ? `${action === "create" ? "Created" : action === "delete" ? "Deleted" : "Edited"} ${fileName}`
            : `Failed to ${action} ${fileName}`;

          addLog(messageId, {
            kind: action || "edit",
            text: ok ? `✓ ${path}` : `✗ ${path}${error ? ` — ${error}` : ""}`,
            at: now,
          });
          addStep(messageId, {
            kind,
            text: label,
            detail: path.includes("/") ? path : undefined,
            status: ok ? "done" : "error",
          });
          break;
        }

        case "done":
          end(messageId);
          break;

        default:
          break;
      }
    },
    [begin, end, addStep, addLog]
  );

  const getTrace = useCallback(
    (messageId: string): TraceState => traces[messageId] || emptyTrace(),
    [traces]
  );

  return { onSSEEvent, getTrace, begin, end };
}
