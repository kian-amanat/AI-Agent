"use client";

import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Archive, FolderTree, PanelLeftClose,
  PanelRightClose, Settings, Shield, ShieldCheck,
} from "lucide-react";

type PermissionMode = "auto" | "ask";

export default function ChatHeader({
  onToggleSidebar,
  permissionMode,
  onTogglePermissionMode,
  onCompact,
  onToggleFileTree,
  fileTreeOpen,
  isSending,
}: {
  onToggleSidebar:        () => void;
  permissionMode:         PermissionMode;
  onTogglePermissionMode: () => void;
  onCompact:              () => void;
  onToggleFileTree:       () => void;
  fileTreeOpen:           boolean;
  isSending:              boolean;
}) {
  const router = useRouter();
  const isAsk = permissionMode === "ask";

  return (
    <header className="fixed top-0 right-0 z-20 flex min-w-0 items-center gap-2 px-3 pt-3">
      {/* Mobile sidebar toggle */}
      <button
        onClick={onToggleSidebar}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03] text-white/65 transition-colors hover:bg-white/[0.06] hover:text-[#ff6a3d] md:hidden"
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
      >
        <PanelLeftClose className="h-4 w-4" />
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        {/* Permission mode toggle */}
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onTogglePermissionMode}
          disabled={isSending}
          title={isAsk ? "Ask mode: you approve each plan before execution" : "Auto mode: changes apply automatically"}
          className={`flex h-[34px] items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-medium transition-colors duration-200 disabled:opacity-40 ${
            isAsk
              ? "border-[#ff8a3d]/30 bg-[#ff8a3d]/8 text-[#ff8a3d]"
              : "border-white/[0.06] bg-white/[0.03] text-white/45 hover:bg-white/[0.05] hover:text-white/70"
          }`}
        >
          {isAsk
            ? <ShieldCheck className="h-3.5 w-3.5" />
            : <Shield      className="h-3.5 w-3.5" />
          }
          <span className="hidden sm:inline">{isAsk ? "Ask" : "Auto"}</span>
        </motion.button>

        {/* Compact */}
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onCompact}
          disabled={isSending}
          title="Compact conversation"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.03] text-white/45 transition-colors hover:bg-white/[0.05] hover:text-white/70 disabled:opacity-40"
        >
          <Archive className="h-3.5 w-3.5" />
        </motion.button>

        {/* File tree toggle */}
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onToggleFileTree}
          title="Toggle file tree"
          className={`flex h-[34px] w-[34px] items-center justify-center rounded-xl border transition-colors ${
            fileTreeOpen
              ? "border-[#ff8a3d]/25 bg-[#ff8a3d]/8 text-[#ff8a3d]"
              : "border-white/[0.06] bg-white/[0.03] text-white/45 hover:bg-white/[0.05] hover:text-white/70"
          }`}
        >
          {fileTreeOpen
            ? <PanelRightClose className="h-3.5 w-3.5" />
            : <FolderTree      className="h-3.5 w-3.5" />
          }
        </motion.button>

        {/* Settings */}
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => router.push("/settings")}
          title="Settings"
          aria-label="Settings"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.03] text-white/45 transition-colors hover:bg-white/[0.06] hover:text-[#ff4d4d] hover:border-[#ff3333]/30"
        >
          <Settings className="h-4 w-4" />
        </motion.button>
      </div>
    </header>
  );
}
