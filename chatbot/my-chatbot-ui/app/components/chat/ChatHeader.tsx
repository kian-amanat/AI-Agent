"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Gauge, PanelLeftClose, Plus, Sparkles, Zap } from "lucide-react";

type ModelOption = "pro" | "normal" | "fast";

export default function ChatHeader({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}) {
  const [model, setModel] = useState<ModelOption>("pro");
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const handleSelectModel = (value: ModelOption) => {
    setModel(value);
    setOpen(false);
  };

  const modelLabel = useMemo(() => {
    switch (model) {
      case "pro":
        return "Pro · Max quality";
      case "fast":
        return "Fast · Lowest latency";
      default:
        return "Normal · Balanced";
    }
  }, [model]);

  const headerAccentClass = useMemo(() => {
    switch (model) {
      case "pro":
        return "text-[#ffb26a]";
      case "fast":
        return "text-[#91ea92]";
      default:
        return "text-[#ff9a6b]";
    }
  }, [model]);

  return (
<header className="
  fixed
  top-0
  right-0
  left-[sidebarWidth]
  z-20
">  
   <div className="flex min-w-0 items-center gap-2.5">
        <button
          onClick={onToggleSidebar}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03] text-white/65 transition-colors duration-200 hover:bg-white/[0.06] hover:text-white md:hidden"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>

        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03] text-[#ffb26a]">
            <Sparkles className="h-3.5 w-3.5" />
          </div>

          <div className="min-w-0">
            <p className={`truncate text-xs font-medium ${headerAccentClass}`}>
              {modelLabel}
            </p>
            <p className="truncate text-[11px] text-white/24">
              Minimal chat interface
            </p>
          </div>
        </div>
      </div>

      <div ref={menuRef} className="relative flex items-center justify-end">
        <motion.button
          whileHover={{ scale: 1.02, y: -0.5 }}
          whileTap={{ scale: 0.96 }}
          onClick={() => setOpen((prev) => !prev)}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03] text-white/82 transition-colors duration-150 hover:bg-white/[0.07]"
          aria-label="Choose model"
          title="Choose model"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
        </motion.button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 12, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.22, 0.61, 0.36, 1] }}
              className="absolute right-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-2xl border border-white/[0.05] bg-black/20 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-2xl"
            >
              <div className="p-1">
                <ModelItem
                  active={model === "pro"}
                  icon={<Zap className="h-3.5 w-3.5" />}
                  title="Pro"
                  badge="Max quality"
                  onClick={() => handleSelectModel("pro")}
                />
                <ModelItem
                  active={model === "normal"}
                  icon={<Gauge className="h-3.5 w-3.5" />}
                  title="Normal"
                  badge="Balanced"
                  onClick={() => handleSelectModel("normal")}
                />
                <ModelItem
                  active={model === "fast"}
                  icon={<Zap className="h-3.5 w-3.5 rotate-[-14deg]" />}
                  title="Fast"
                  badge="Low latency"
                  onClick={() => handleSelectModel("fast")}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}

function ModeIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_0%,#ffbf7a_0,#ff8c5c_38%,#a94224_100%)] text-white shadow-[0_0_16px_rgba(255,140,92,0.5)]">
      {children}
    </div>
  );
}

function ModelItem({
  active,
  icon,
  title,
  badge,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  badge: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all duration-150",
        active ? "bg-white/[0.06]" : "bg-transparent hover:bg-white/[0.03]",
      ].join(" ")}
    >
      <ModeIcon>{icon}</ModeIcon>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span
            className={[
              "text-[13px] font-medium tracking-[-0.01em]",
              active ? "text-[#ffb26a]" : "text-[#ff9f6f]",
            ].join(" ")}
          >
            {title}
          </span>
          <span
            className={[
              "text-[10px] font-medium tracking-[0.02em]",
              active ? "text-[#ffb26a]" : "text-[#ff9f6f]/80",
            ].join(" ")}
          >
            {badge}
          </span>
        </div>
      </div>
    </button>
  );
}