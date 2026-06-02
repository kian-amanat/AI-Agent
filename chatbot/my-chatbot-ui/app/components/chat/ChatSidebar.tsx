"use client";

import React from "react";
import { motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import type { Conversation } from "./chat-types";

export default function ChatSidebar({
  isSidebarCollapsed,
  onToggleSidebar,
  onStartNewChat,
  conversationSearch,
  setConversationSearch,
  filteredConversations,
  selectedSessionId,
  onOpenSession,
  onDeleteSession,
  loadingSessions,
}: {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onStartNewChat: () => void;
  conversationSearch: string;
  setConversationSearch: (value: string) => void;
  filteredConversations: Conversation[];
  selectedSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  loadingSessions: boolean;
}) {
  return (
    <motion.aside
      animate={{ width: isSidebarCollapsed ? 76 : 318 }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      className="flex h-full shrink-0 flex-col border-r border-white/8 bg-[#151515]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/8 p-3">
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={onToggleSidebar}
          className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
          title={isSidebarCollapsed ? "Open sidebar" : "Collapse sidebar"}
        >
          {isSidebarCollapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
        </motion.button>

        {!isSidebarCollapsed && (
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-white/8 bg-gradient-to-br from-[#ff8a3d]/18 to-[#ff5e4d]/12 text-white/88">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">AI Assistant</p>
              <p className="truncate text-xs text-white/40">Minimal Chat Workspace</p>
            </div>
          </div>
        )}

        {!isSidebarCollapsed && (
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={onStartNewChat}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/72 transition-colors duration-200 hover:border-[#ff8a3d]/25 hover:bg-[#ff8a3d]/10 hover:text-white"
            title="New chat"
          >
            <Plus className="h-5 w-5" />
          </motion.button>
        )}
      </div>

      {!isSidebarCollapsed && (
        <div className="border-b border-white/8 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
            <input
              value={conversationSearch}
              onChange={(e) => setConversationSearch(e.target.value)}
              placeholder="Search conversations"
              className="h-11 w-full rounded-2xl border border-white/8 bg-white/[0.03] pl-9 pr-3 text-sm text-white outline-none transition-all duration-300 placeholder:text-white/25 focus:border-[#ff8a3d]/30 focus:bg-white/[0.05]"
            />
          </div>

          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.99 }}
            onClick={onStartNewChat}
            className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3 text-left transition-colors duration-200 hover:border-[#ff8a3d]/20 hover:bg-[#ff8a3d]/8"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff6a3d] via-[#ff4d3d] to-[#ff2d2d] text-white shadow-[0_10px_22px_rgba(255,77,61,0.18)]">
              <Plus className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">New chat</p>
              <p className="truncate text-xs text-white/35">Start a fresh conversation</p>
            </div>
          </motion.button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loadingSessions && filteredConversations.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-white/40">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading conversations...
          </div>
        ) : (
          filteredConversations.map((conversation) => {
            const isSelected = selectedSessionId === conversation.id;

            return (
              <motion.div
                key={conversation.id}
                whileHover={{ x: 1 }}
                whileTap={{ scale: 0.99 }}
                onClick={() => onOpenSession(conversation.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onOpenSession(conversation.id)}
                className={`group mb-1 flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition-all duration-200 ${
                  isSelected
                    ? "border border-[#ff8a3d]/20 bg-white/[0.06]"
                    : "border border-transparent hover:bg-white/[0.04]"
                }`}
                title={conversation.title}
              >
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-white/70 transition-colors group-hover:border-white/12 group-hover:bg-white/[0.05] group-hover:text-white">
                  <MessageSquare className="h-4 w-4" />
                </div>

                {!isSidebarCollapsed && (
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-sm font-medium text-white">{conversation.title}</p>
                      <span className="shrink-0 text-[11px] text-white/28">{conversation.updatedAt}</span>
                    </div>
                    <p className="mt-1 truncate text-xs leading-5 text-white/38">
                      {conversation.preview}
                    </p>
                  </div>
                )}

                {!isSidebarCollapsed && (
                  <div className="mt-1 flex items-center gap-1 opacity-0 transition-all duration-200 group-hover:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteSession(conversation.id);
                      }}
                      className="rounded-lg p-1 text-white/25 transition-colors hover:bg-white/[0.04] hover:text-white/75"
                      title="Delete conversation"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>

                    <div className="rounded-lg p-1 text-white/22 hover:bg-white/[0.04] hover:text-white/70">
                      <MoreHorizontal className="h-4 w-4" />
                    </div>
                  </div>
                )}
              </motion.div>
            );
          })
        )}
      </div>

      <div className="border-t border-white/8 p-3">
        <button className="flex w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3 text-left transition-colors duration-200 hover:bg-white/[0.05]">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/8 bg-white/[0.04]">
            <User className="h-4 w-4 text-white/80" />
          </div>
          {!isSidebarCollapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">Kian</p>
              <p className="truncate text-xs text-white/35">Free plan</p>
            </div>
          )}
          {!isSidebarCollapsed && <MoreHorizontal className="h-4 w-4 text-white/25" />}
        </button>
      </div>
    </motion.aside>
  );
}