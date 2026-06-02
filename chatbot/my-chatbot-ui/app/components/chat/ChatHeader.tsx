"use client";

import { Sparkles, Search, ChevronRight } from "lucide-react";

export default function ChatHeader({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-white/8 px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:bg-white/[0.05] hover:text-white md:hidden"
          title="Toggle sidebar"
        >
          <ChevronRight className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-white/8 bg-gradient-to-br from-[#ff8a3d]/18 to-[#ff5e4d]/12 text-white/88">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">AI Assistant</p>
            <p className="truncate text-xs text-white/35">Modern minimal chat interface</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:bg-white/[0.05] hover:text-white">
          <Search className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}