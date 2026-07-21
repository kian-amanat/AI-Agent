"use client";

import React, { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Clock,
  Loader2,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { Conversation } from "./chat-types";
import Image from 'next/image';

/* ── Ambient glow behind the sidebar (cinematic, matches landing2) ── */
function SidebarGlow() {
  return (
    <div className="pointer-events-none absolute -left-20 top-1/2 h-[420px] w-[320px] -translate-y-1/2">
      <motion.div
        animate={{ scale: [1, 1.08, 1], opacity: [0.06, 0.11, 0.06] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        className="h-full w-full rounded-full bg-[#ff8a3d] blur-[120px]"
      />
    </div>
  );
}

/* ── Compact glowing plus (collapsed state) ── */
function GlowingPlusIcon({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="relative flex h-7 w-7 items-center justify-center rounded-full" style={{
        background: "linear-gradient(135deg, #ff8a3d, #ff5e4d)",
        boxShadow: "0 0 14px rgba(255,138,61,0.35)",
      }}>
        <Plus className="relative z-10 h-3.5 w-3.5 text-white" strokeWidth={2.8} />
      </div>
    );
  }

  return (
    <div className="relative flex h-8 w-8 items-center justify-center rounded-full" style={{
      background: "conic-gradient(from 0deg, #ff8a3d, #ff5e4d, #ff3d3d, #ff8a3d)",
      boxShadow: "0 0 14px rgba(255,138,61,0.35)",
    }}>
      <Plus className="relative z-10 h-3.5 w-3.5 text-white" strokeWidth={2.8} />
    </div>
  );
}

/* ── Collapse/expand toggle icon ── */
function CollapseToggle({ collapsed, hovered }: { collapsed: boolean; hovered: boolean }) {
  return (
    <AnimatePresence mode="wait">
      {collapsed ? (
        !hovered ? (
          <motion.div
            key="icon"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <Image src="/icon.png" alt="Open sidebar" width={22} height={22} className="rounded-md" />
          </motion.div>
        ) : (
          <motion.div
            key="arrow"
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <PanelLeftOpen className="h-4 w-4 text-white/80" />
          </motion.div>
        )
      ) : (
        <motion.div
          key="left-arrow"
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 4 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <PanelLeftClose className="h-4 w-4 text-white/60" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Sidebar section header ── */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-3 pt-4 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30">
      {children}
    </h2>
  );
}

/* ── Conversation row ── */
function ConversationRow({
  conversation,
  isSelected,
  onOpen,
  onDelete,
}: {
  conversation: Conversation;
  isSelected: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <motion.div
      layout
      whileHover={{ x: 1.5 }}
      className={`group mb-1 flex w-full items-stretch gap-2 rounded-xl transition-colors duration-150 ${
        isSelected
          ? "bg-white/[0.06]"
          : "hover:bg-white/[0.035]"
      }`}
    >
      {/* Active indicator line */}
      <span
        className={`mt-0.5 h-5 w-[2px] shrink-0 rounded-full transition-colors duration-200 ${
          isSelected
            ? "bg-[#ff8a3d]"
            : "bg-transparent group-hover:bg-white/12"
        }`}
      />

      {/* Title + time */}
      <button
        onClick={() => onOpen(conversation.id)}
        className="min-w-0 flex-1 px-2 py-1.5 text-left"
        title={conversation.title}
      >
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[13px] font-medium leading-tight text-white/80 group-hover:text-white/95">
            {conversation.title || "Untitled"}
          </p>
          {conversation.updatedAt && (
            <span className="shrink-0 text-[10px] tabular-nums text-white/25">
              {conversation.updatedAt}
            </span>
          )}
        </div>
      </button>

      {/* More menu */}
      <div className="relative mr-1.5 mt-1.5 flex items-start">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="rounded-md p-1 text-white/20 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-white/[0.05] hover:text-white/70"
          title="More actions"
          aria-label="More actions"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>

        <AnimatePresence>
          {menuOpen && (
            <>
              {/* Backdrop to close */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <motion.div
                ref={menuRef}
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -4 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="absolute right-0 top-7 z-20 w-28 overflow-hidden rounded-xl border border-white/[0.08] bg-[#1a1a1a] py-1 shadow-lg"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-white/60 hover:bg-white/[0.05] hover:text-white/85"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(conversation.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-[#ff5e4d]" />
                  Delete
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/* ── Skeleton row for loading state ── */
function SkeletonRow() {
  return (
    <div className="mb-1 flex w-full items-stretch gap-2 rounded-xl px-2 py-1.5 text-sm">
      <span className="mt-0.5 h-5 w-[2px] shrink-0 rounded-full bg-white/8" />
      <div className="flex min-w-0 flex-1 gap-3 px-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="h-[13px] w-2/3 animate-pulse rounded bg-white/8" />
            <div className="h-[10px] w-8 animate-pulse rounded bg-white/8" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── User section at the bottom (Claude-style) ── */
function UserSection({ name, email, onNavigate }: { name?: string; email?: string; onNavigate?: () => void }) {
  const initials = (name || "U")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="border-t border-white/[0.06] px-3 py-2.5">
      <button
        onClick={onNavigate}
        className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors duration-150 hover:bg-white/[0.05]"
        title={name || "User settings"}
      >
        {/* Avatar circle with initials */}
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: "linear-gradient(135deg, #ff8a3d, #ff5e4d)" }}
        >
          {initials}
        </div>

        {/* Name + email */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium leading-tight text-white/80">
            {name || "User"}
          </p>
          {email && (
            <p className="truncate text-[11px] leading-tight text-white/30">{email}</p>
          )}
        </div>

        {/* Chevron */}
        <svg
          className="h-3.5 w-3.5 shrink-0 text-white/20"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ChatSidebar — floating, premium, synced with project tokens
   ═══════════════════════════════════════════════════════════ */
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
  userName,
  userEmail,
  onNavigateProfile,
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
  userName?: string;
  userEmail?: string;
  onNavigateProfile?: () => void;
}) {
  const [isSidebarHovered, setIsSidebarHovered] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const openSidebarIfCollapsed = () => {
    if (isSidebarCollapsed) onToggleSidebar();
  };

  return (
    <motion.aside
      animate={{ width: isSidebarCollapsed ? 72 : 310 }}
      transition={{ type: "spring", stiffness: 280, damping: 28 }}
      onMouseEnter={() => setIsSidebarHovered(true)}
      onMouseLeave={() => setIsSidebarHovered(false)}
      className="relative ml-3 mt-3 mb-3 flex h-[calc(100vh-1.5rem)] shrink-0 flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-[#161616]/95 shadow-[0_8px_32px_rgba(0,0,0,0.25)] backdrop-blur-xl"
    >
      {/* Ambient glow — cinematic, matches landing2 */}
      <SidebarGlow />

      {/* ── Header ── */}
      <div className="relative flex items-center justify-between gap-2 px-3 py-3">
        {/* Logo only (hidden when collapsed) */}
        {!isSidebarCollapsed && (
          <div className="flex items-center gap-2.5 overflow-hidden">
            <Image
              src="/icon.png"
              alt=""
              width={28}
              height={28}
              quality={100}
              className="shrink-0 rounded-lg"
            />
          </div>
        )}

        {/* Collapse / expand toggle */}
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onToggleSidebar}
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 hover:bg-white/[0.06] ${
            isSidebarCollapsed ? "mx-auto" : ""
          }`}
          title={isSidebarCollapsed ? "Open sidebar" : "Collapse sidebar"}
          aria-label={isSidebarCollapsed ? "Open sidebar" : "Collapse sidebar"}
        >
          <CollapseToggle collapsed={isSidebarCollapsed} hovered={isSidebarHovered} />
        </motion.button>
      </div>

      {/* ── Collapsed icon buttons ── */}
      {isSidebarCollapsed && (
        <div className="relative flex flex-col items-center gap-2.5 pb-4">
          <motion.button
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            onClick={() => {
              openSidebarIfCollapsed();
              setTimeout(() => searchInputRef.current?.focus(), 100);
            }}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/85"
            title="Search"
          >
            <Search className="h-4 w-4" />
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.08, y: -1 }}
            whileTap={{ scale: 0.92 }}
            onClick={() => { onStartNewChat(); openSidebarIfCollapsed(); }}
            title="New chat"
          >
            <GlowingPlusIcon compact />
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            onClick={openSidebarIfCollapsed}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/85"
            title="Recent chats"
          >
            <Clock className="h-4 w-4" />
          </motion.button>
        </div>
      )}

      {/* ── Search + New chat (expanded only) ── */}
      {!isSidebarCollapsed && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="relative px-3 pb-3"
        >
          {/* Search input */}
          <div className="relative mb-2.5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
            <input
              ref={searchInputRef}
              value={conversationSearch}
              onChange={(e) => setConversationSearch(e.target.value)}
              placeholder="Search conversations"
              className="h-10 w-full rounded-xl border border-white/[0.06] bg-white/[0.03] pl-9 pr-3 text-[13px] text-white/80 outline-none transition-all duration-200 placeholder:text-white/22 focus:border-[#ff8a3d]/25 focus:bg-white/[0.05]"
            />
          </div>

          {/* New chat button */}
          <motion.button
            whileHover={{ y: -0.5 }}
            whileTap={{ scale: 0.98 }}
            onClick={onStartNewChat}
            className="relative flex w-full items-center gap-3 rounded-xl bg-white/[0.03] px-3.5 py-2.5 text-left text-[13px] text-white/70 transition-all duration-200 hover:bg-white/[0.05]"
          >
            {filteredConversations.length === 0 && (
              <span className="absolute right-3 top-3 h-1.5 w-1.5 rounded-full bg-[#ff8a3d]" />
            )}
            <GlowingPlusIcon />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-white/90">New chat</p>
              <p className="truncate text-[11px] text-white/45">Start a fresh conversation</p>
            </div>
          </motion.button>
        </motion.div>
      )}

      {/* ── Section header ── */}
      {!isSidebarCollapsed && <SectionHeader>Chats</SectionHeader>}

      {/* ── Conversation list ── */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {loadingSessions ? (
          <div className="flex flex-col gap-0.5">
            {[...Array(4)].map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Search className="mb-3 h-5 w-5 text-white/15" />
            <p className="text-[12px] text-white/25">
              {conversationSearch
                ? "No conversations match your search"
                : "No conversations yet"}
            </p>
            {!conversationSearch && (
              <p className="mt-1 text-[11px] text-white/15">
                Start a new chat to begin
              </p>
            )}
          </div>
        ) : (
          filteredConversations.map((conversation) => {
            const isSelected = selectedSessionId === conversation.id;
            if (isSidebarCollapsed) return null;

            return (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                isSelected={isSelected}
                onOpen={onOpenSession}
                onDelete={onDeleteSession}
              />
            );
          })
        )}
      </div>

      {/* ── User section (bottom) ── */}
      {!isSidebarCollapsed && (
        <UserSection name={userName} email={userEmail} onNavigate={onNavigateProfile} />
      )}
    </motion.aside>
  );
}
