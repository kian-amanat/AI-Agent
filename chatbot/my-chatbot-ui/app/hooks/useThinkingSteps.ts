"use client";

import { useCallback, useRef, useState } from "react";
import type { SSEEvent } from "../lib/api";
import type { ThinkingStep, ThinkingStepKind } from "../components/chat/ThinkingTrace";

/**
 * useThinkingSteps
 * Converts the live SSE stream into a list of ThinkingStep objects
 * for the ThinkingTrace component (Claude-style inline thinking).
 *
 * Returns one trace per assistant message, keyed by messageId.
 */

let _counter = 0;
const nextId = () => `ts_${Date.now()}_${_counter++}`;

interface TraceState {
  steps: ThinkingStep[];
  startedAt: number | null;
  isActive: boolean;
}

const emptyTrace = (): TraceState => ({ steps: [], startedAt: null, isActive: false });

export function useThinkingSteps() {
  // messageId → trace
  const [traces, setTraces] = useState<Record<string, TraceState>>({});
  const activeMsgRef = useRef<string | null>(null);

  const begin = useCallback((messageId: string) => {
    activeMsgRef.current = messageId;
    setTraces(prev => ({
      ...prev,
      [messageId]: { steps: [], startedAt: Date.now(), isActive: true },
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
        const newStep: ThinkingStep = { ...step, id: nextId(), at: Date.now() };
        return {
          ...prev,
          [messageId]: {
            steps: [...t.steps, newStep],
            startedAt: t.startedAt ?? Date.now(),
            isActive: true,
          },
        };
      });
    },
    []
  );

  /**
   * Feed every SSEEvent here. messageId = the assistant message being built.
   */
  const onSSEEvent = useCallback(
    (messageId: string, event: SSEEvent) => {
      switch (event.type) {
        case "start":
          begin(messageId);
          break;

        case "progress": {
          const stage = (event as any).stage || "";
          const msg   = (event as any).message || "";
          if (!msg) break;

          // Map backend stages → step kinds
          let kind: ThinkingStepKind = "info";
          if (/rout/i.test(stage))                       kind = "route";
          else if (/explor|scan|read/i.test(stage))      kind = "explore";
          else if (/plan/i.test(stage))                  kind = "plan";
          else if (/exec|step|appl/i.test(stage))        kind = "edit";
          else if (/verif/i.test(stage))                 kind = "verify";

          // Strip leading emoji for cleaner text (icon already shows)
          const clean = msg.replace(/^[\u{1F000}-\u{1FFFF}\u2600-\u27BF\s]+/u, "").trim();
          addStep(messageId, { kind, text: clean || msg });
          break;
        }

        case "file_context": {
          const files = (event as any).files || [];
          if (files.length > 0) {
            addStep(messageId, {
              kind: "explore",
              text: `Loaded ${files.length} relevant file${files.length !== 1 ? "s" : ""}`,
            });
          }
          break;
        }

        case "plan": {
          const steps = (event as any).steps || [];
          const reasoning = (event as any).reasoning || "";
          if (reasoning) {
            addStep(messageId, { kind: "plan", text: reasoning });
          }
          for (const s of steps) {
            const action = (s.action || "").toLowerCase();
            let kind: ThinkingStepKind = "edit";
            if (action === "create") kind = "create";
            else if (action === "delete") kind = "delete";
            else if (action === "read_only") kind = "info";
            const fileName = s.path ? s.path.split("/").pop() : "";
            addStep(messageId, {
              kind,
              text: s.description || `${action} ${fileName}`,
              detail: fileName,
            });
          }
          break;
        }

        case "file_change": {
          const action = ((event as any).action || "").toLowerCase();
          const path   = (event as any).path || "";
          const ok     = (event as any).success;
          const fileName = path.split("/").pop();
          let kind: ThinkingStepKind = "edit";
          if (action === "create") kind = "create";
          else if (action === "delete") kind = "delete";
          addStep(messageId, {
            kind,
            text: ok
              ? `${action === "create" ? "Created" : action === "delete" ? "Deleted" : "Edited"} ${fileName}`
              : `Failed to ${action} ${fileName}`,
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
    [begin, end, addStep]
  );

  const getTrace = useCallback(
    (messageId: string): TraceState => traces[messageId] || emptyTrace(),
    [traces]
  );

  return { onSSEEvent, getTrace, begin, end };
}
