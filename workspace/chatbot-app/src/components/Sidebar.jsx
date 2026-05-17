import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Plus, Settings } from "lucide-react";

export default function Sidebar({ onToggleCollapse, onOpenSettings }) {
  const conversations = [
    "Welcome chat",
    "Design ideas",
    "Marketing plan",
    "Daily summary",
    "Code review notes",
  ];

  return (
    <div className="h-full flex flex-col p-4 gap-3 bg-[#121212]">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[#f5f5f5]">Chats</h2>
        <Button
          variant="ghost"
          className="text-xs text-[#9ca3af] hover:text-white"
          onClick={onToggleCollapse}
        >
          Collapse
        </Button>
      </div>

      <Button className="w-full rounded-xl bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#272727] text-[#f5f5f5] justify-start gap-2">
        <Plus size={16} />
        New Chat
      </Button>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9ca3af]" />
        <Input
          className="pl-9 bg-[#181818] border-[#272727] text-[#f5f5f5] placeholder:text-[#9ca3af] rounded-xl"
          placeholder="Search"
        />
      </div>

      <ScrollArea className="flex-1 rounded-xl border border-[#272727] bg-[#181818]">
        <div className="p-2 space-y-1">
          {conversations.map((item, idx) => (
            <button
              key={idx}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-[#f5f5f5] hover:bg-[#242424]"
            >
              {item}
            </button>
          ))}
        </div>
      </ScrollArea>

      <div className="pt-1">
        <Button
          onClick={onOpenSettings}
          className="w-full rounded-xl bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#272727] justify-start gap-2 text-[#f5f5f5]"
        >
          <Settings size={16} />
          Settings
        </Button>
      </div>
    </div>
  );
}
