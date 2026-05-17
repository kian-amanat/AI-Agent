import React from "react";

export default function MessageBubble({ role, children }) {
  const isAssistant = role === "assistant";
  return (
    <div className={`w-fit max-w-full ${isAssistant ? "ml-0" : "ml-auto"}`}>
      <div
        className={`rounded-[18px] px-4 py-[10px] border border-[#272727] ${
          isAssistant ? "bg-[#262626]" : "bg-[#1f2933]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
