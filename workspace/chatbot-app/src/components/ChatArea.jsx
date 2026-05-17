import React, { useState } from "react";
import ChatHeader from "@/components/ChatHeader";
import MessageList from "@/components/MessageList";
import InputBar from "@/components/InputBar";

export default function ChatArea() {
  const [messages, setMessages] = useState([
    { id: 1, role: "assistant", content: "Hello" },
  ]);

  const handleSend = (value) => {
    const userMessage = { id: Date.now(), role: "user", content: value };
    const assistantMessage = {
      id: Date.now() + 1,
      role: "assistant",
      content: "Got it — thanks for your message.",
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
  };

  return (
    <div className="h-full flex flex-col bg-[#0f0f10]">
      <ChatHeader />
      <div className="flex-1 min-h-0">
        <MessageList messages={messages} />
      </div>
      <InputBar onSend={handleSend} />
    </div>
  );
}
