import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";

export default function InputBar({ onSend }) {
  const [value, setValue] = useState("");

  const submit = () => {
    if (value.trim()) {
      onSend(value);
      setValue("");
    }
  };

  return (
    <div className="px-8 py-4 border-t border-[#272727] bg-[#0f0f10]">
      <div className="h-14 rounded-full bg-[#5d5d5d] px-5 flex items-center gap-3">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Type a message..."
          className="border-0 shadow-none bg-transparent text-[#f5f5f5] placeholder:text-[#d1d5db] focus-visible:ring-0"
        />
        <Button
          onClick={submit}
          className="h-9 w-9 p-0 rounded-full bg-[#fb7185] hover:bg-[#f43f5e] text-white"
        >
          <Send size={16} />
        </Button>
      </div>
    </div>
  );
}
