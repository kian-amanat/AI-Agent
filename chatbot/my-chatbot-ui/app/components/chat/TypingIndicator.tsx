import React from "react";

export default function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-1">
      <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-r from-[#ff8a3d] to-[#ff5e4d] [animation-delay:-0.2s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-r from-[#ff8a3d] to-[#ff5e4d] [animation-delay:-0.1s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-gradient-to-r from-[#ff8a3d] to-[#ff5e4d]" />
    </div>
  );
}