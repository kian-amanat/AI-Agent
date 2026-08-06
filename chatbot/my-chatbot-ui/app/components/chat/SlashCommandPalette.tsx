"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Archive, Eraser, HelpCircle, RotateCcw,
  FileText, Brain, Sparkles, Webhook, Bot, Plug, Terminal, Command as CommandIcon,
} from "lucide-react";
import { fetchCommands, type ServerCommand } from "../../lib/api";
import { filterCommands, moveSelection, resolveSelection, isDismissKey } from "../../lib/commandPalette";

/**
 * Two kinds of command share this palette:
 *
 *   ACTION  — handled entirely in the client (clear the view, compact, undo).
 *             Selecting one dispatches immediately.
 *   COMMAND — handled by the backend (/help, /init, /memory, … plus anything in
 *             .kodo/commands and .kodo/skills). Selecting one INSERTS the text
 *             so the user can add arguments and press Enter — the only way a
 *             command with required arguments can actually be used.
 *
 * Built-ins are listed here rather than fetched because they live in the
 * route's own switch, not the command registry. Custom commands come from the
 * backend, so a .md file added moments ago appears without a rebuild.
 */

export type SlashCommandId = "clear" | "compact" | "undo" | "help";

type Item = {
  key:         string;
  label:       string;          // "/deploy"
  description: string;
  kind:        "action" | "command";
  actionId?:   SlashCommandId;  // action only
  insert?:     string;          // command only — text placed in the composer
  group:       string;
  badge?:      string;
  disabled?:   boolean;
  Icon:        React.ElementType;
};

const ACTIONS: Item[] = [
  { key: "a:clear",   label: "/clear",   description: "Clear all messages in this conversation",    kind: "action", actionId: "clear",   group: "Actions", Icon: Eraser    },
  { key: "a:compact", label: "/compact", description: "Summarise the conversation to free context", kind: "action", actionId: "compact", group: "Actions", Icon: Archive   },
  { key: "a:undo",    label: "/undo",    description: "Undo the last set of file changes",          kind: "action", actionId: "undo",    group: "Actions", Icon: RotateCcw },
];

// Mirrors the switch in routes/plannerAgent.mjs → handleSlashCommand.
const BUILTINS: Item[] = [
  { key: "b:help",     label: "/help",     description: "List every available command",                   kind: "command", insert: "/help",     group: "Built-in", Icon: HelpCircle },
  { key: "b:init",     label: "/init",     description: "Analyse the workspace and generate KODO.md",      kind: "command", insert: "/init",     group: "Built-in", Icon: FileText   },
  { key: "b:memory",   label: "/memory",   description: "Show what Kodo remembers about this project",     kind: "command", insert: "/memory",   group: "Built-in", Icon: Brain      },
  { key: "b:skills",   label: "/skills",   description: "List available expert skills",                    kind: "command", insert: "/skills",   group: "Built-in", Icon: Sparkles   },
  { key: "b:commands", label: "/commands", description: "List custom slash commands",                      kind: "command", insert: "/commands", group: "Built-in", Icon: Terminal   },
  { key: "b:agents",   label: "/agents",   description: "Show subagents, their tools and model",           kind: "command", insert: "/agents",   group: "Built-in", Icon: Bot        },
  { key: "b:hooks",    label: "/hooks",    description: "Show configured lifecycle hooks",                 kind: "command", insert: "/hooks",    group: "Built-in", Icon: Webhook    },
  { key: "b:mcp",      label: "/mcp",      description: "Show MCP servers, tools, prompts and resources",   kind: "command", insert: "/mcp",      group: "Built-in", Icon: Plug       },
];

function customToItem(c: ServerCommand): Item {
  // A command taking arguments gets a trailing space so the user can type them
  // straight away; one without is ready to send as-is.
  const needsArgs = c.arguments.length > 0;
  return {
    key:         `c:${c.name}`,
    label:       `/${c.name}`,
    description: c.disabledReason ? `Disabled — ${c.disabledReason}` : c.description,
    kind:        "command",
    insert:      needsArgs ? `/${c.name} ` : `/${c.name}`,
    group:       c.scope === "user" ? "Your commands" : "Project commands",
    badge:       c.arguments.filter((a) => a.required).map((a) => `<${a.name}>`).join(" ") || undefined,
    disabled:    !c.enabled,
    Icon:        CommandIcon,
  };
}

/**
 * `inline`  — anchored above the composer, driven by what the user typed after
 *             "/". The composer owns the query.
 * `modal`   — the Cmd/Ctrl+K palette: centred, dimmed backdrop, and it owns its
 *             OWN search box, because there is no composer text to derive a
 *             query from when it is opened by the shortcut.
 */
export type PaletteMode = "inline" | "modal";

export default function SlashCommandPalette({
  query,
  visible,
  onSelect,
  onInsert,
  mode = "inline",
  onClose,
}: {
  query:     string;
  visible:   boolean;
  onSelect:  (id: SlashCommandId) => void;
  onInsert?: (text: string) => void;
  mode?:     PaletteMode;
  onClose?:  () => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [custom, setCustom] = useState<Item[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Only the modal keeps its own query; inline mirrors the composer's.
  const [modalQuery, setModalQuery] = useState("");
  const effectiveQuery = mode === "modal" ? modalQuery : query;

  // Reopening always starts from a clean search. Reset DURING render, the same
  // derived-state pattern used for activeIdx below — doing it in an effect
  // would render the stale query for a frame and then re-render.
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible && mode === "modal") setModalQuery("");
  }

  // Focus, by contrast, genuinely IS an external-system side effect. Without
  // it the user has to click the box before typing, which defeats the shortcut.
  useEffect(() => {
    if (mode !== "modal" || !visible) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [visible, mode]);

  // Refresh whenever the palette opens, so a command file added moments ago is
  // already listed. The backend registry is cached, so this is cheap.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void fetchCommands().then((cmds) => {
      if (!cancelled) setCustom(cmds.map(customToItem));
    });
    return () => { cancelled = true; };
  }, [visible]);

  const filtered = useMemo(() => {
    const all = [...ACTIONS, ...BUILTINS, ...custom];
    // An empty query — the user has just typed "/" — shows EVERYTHING.
    // Otherwise rank by fuzzy score, so "cmds" still finds /commands.
    return filterCommands(all, effectiveQuery);
  }, [effectiveQuery, custom]);

  // Reset the highlight when the visible set changes. Done DURING render (the
  // pattern React documents for derived state) rather than in an effect, which
  // would trigger a cascading re-render.
  const listKey = `${effectiveQuery}|${custom.length}`;
  const [prevListKey, setPrevListKey] = useState(listKey);
  if (listKey !== prevListKey) {
    setPrevListKey(listKey);
    setActiveIdx(0);
  }

  // Keep the highlighted row visible when arrowing through a long list.
  useEffect(() => {
    itemRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  useEffect(() => {
    if (!visible) return;

    function choose(item: Item) {
      if (item.disabled) return;
      if (item.kind === "action" && item.actionId) onSelect(item.actionId);
      else if (item.insert) onInsert?.(item.insert);
    }

    function onKey(e: KeyboardEvent) {
      // The modal owns Escape; inline leaves it to the composer, which also
      // has to decide whether Escape means "close the palette" or "blur".
      if (mode === "modal" && isDismissKey(e)) {
        e.preventDefault();
        onClose?.();
        return;
      }
      if (!filtered.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => moveSelection(i, filtered.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => moveSelection(i, filtered.length, -1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = resolveSelection(filtered, activeIdx);
        if (item) choose(item);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, filtered, activeIdx, onSelect, onInsert, mode, onClose]);

  function handleClick(item: Item) {
    if (item.disabled) return;
    if (item.kind === "action" && item.actionId) onSelect(item.actionId);
    else if (item.insert) onInsert?.(item.insert);
  }

  // Once a query is ranking the list, entries from different groups interleave
  // by score — so a header per row would be noise. Headers belong to the
  // unfiltered browse view.
  const showGroups = !effectiveQuery.replace(/^\//, "").trim();

  // Which rows start a new group, computed up front rather than by mutating a
  // variable while mapping: the list is now rendered from two call sites, and
  // a running mutable would carry state between them.
  const headers = filtered.map((item, idx) =>
    showGroups && item.group !== filtered[idx - 1]?.group ? item.group : null,
  );

  const rows = (
    <>
          {filtered.map((item, idx) => {
            const isActive = idx === activeIdx;
            const header = headers[idx];
            return (
              <div key={item.key}>
                {header && (
                  <div className="sticky top-0 bg-[#191919] px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-white/25">
                    {header}
                  </div>
                )}
                <button
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => handleClick(item)}
                  disabled={item.disabled}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-100 ${
                    item.disabled
                      ? "cursor-not-allowed opacity-40"
                      : isActive ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
                  }`}
                >
                  <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                    isActive && !item.disabled
                      ? "border-[#ff8a3d]/30 bg-[#ff8a3d]/10"
                      : "border-white/[0.06] bg-white/[0.03]"
                  }`}>
                    <item.Icon className={`h-3.5 w-3.5 ${isActive && !item.disabled ? "text-[#ff8a3d]" : "text-white/40"}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[13px] font-medium text-white/85">{item.label}</span>
                      {item.badge && (
                        <span className="truncate font-mono text-[10px] text-[#ff8a3d]/70">{item.badge}</span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-white/35">{item.description}</div>
                  </div>
                </button>
              </div>
            );
          })}
          <div className="sticky bottom-0 border-t border-white/[0.05] bg-[#191919] px-3 py-1.5 text-[10px] text-white/20">
            ↑↓ navigate · Enter select · Esc dismiss
          </div>
    </>
  );

  // ── Modal: the Cmd/Ctrl+K palette ─────────────────────────────────────────
  // Rendered even when nothing matches, unlike the inline variant: the user
  // opened this deliberately and typed the query, so "no commands match" is
  // information. The inline one appears unbidden and must not sit there empty.
  if (mode === "modal") {
    return (
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-[2px]"
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.13, ease: "easeOut" }}
              className="flex max-h-[60vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#191919] shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
            >
              <div className="flex items-center gap-2.5 border-b border-white/[0.06] px-4 py-3">
                <CommandIcon className="h-4 w-4 shrink-0 text-white/30" />
                <input
                  ref={inputRef}
                  value={modalQuery}
                  onChange={(e) => setModalQuery(e.target.value)}
                  placeholder="Search commands…"
                  aria-label="Search commands"
                  className="w-full bg-transparent text-[14px] text-white outline-none placeholder:text-white/25"
                />
                <kbd className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/30">esc</kbd>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                {filtered.length > 0 ? rows : (
                  <div className="px-4 py-8 text-center text-[12px] text-white/30">
                    No commands match “{modalQuery}”
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence>
      {visible && filtered.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.13, ease: "easeOut" }}
          className="absolute bottom-full left-0 z-50 mb-2 max-h-[22rem] w-80 overflow-y-auto overflow-x-hidden rounded-2xl border border-white/[0.08] bg-[#191919] shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
        >
          {rows}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
