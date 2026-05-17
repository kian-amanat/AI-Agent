import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import ChatArea from "@/components/ChatArea";
import Sidebar from "@/components/Sidebar";

export default function Layout() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  return (
    <div className="w-full h-full flex bg-[#0f0f10]">
      <div className="flex-1 min-w-0 h-full">
        <ChatArea />
      </div>

      <div
        className={`h-full border-l border-[#272727] bg-[#121212] transition-all duration-300 ease-in-out overflow-hidden ${
          isSidebarCollapsed ? "w-0" : "w-[823px]"
        }`}
      >
        {!isSidebarCollapsed && (
          <Sidebar
            onToggleCollapse={() => setIsSidebarCollapsed(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}
      </div>

      {isSidebarCollapsed && (
        <Button
          onClick={() => setIsSidebarCollapsed(false)}
          className="absolute top-4 right-4 rounded-full bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#f5f5f5] border border-[#272727]"
        >
          Open Chats
        </Button>
      )}

      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            className="relative z-10 w-full max-w-md rounded-2xl border border-[#272727] bg-[#181818] p-6 text-[#f5f5f5]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Settings</h2>
              <Button
                variant="ghost"
                className="text-[#9ca3af] hover:text-white"
                onClick={() => setIsSettingsOpen(false)}
              >
                Close
              </Button>
            </div>
            <div className="space-y-3 text-sm text-[#9ca3af]">
              <p>Theme: Dark</p>
              <p>Model: Default Assistant</p>
              <p>Notifications: Enabled</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
