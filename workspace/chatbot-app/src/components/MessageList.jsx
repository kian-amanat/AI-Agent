import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import MessageBubble from "@/components/MessageBubble";
import { Button } from "@/components/ui/button";

export default function MessageList({ messages }) {
  const onCopy = (msg) => console.log("Copy", msg.id);
  const onRegenerate = (msg) => console.log("Regenerate", msg.id);
  const onLike = (msg) => console.log("Like", msg.id);

  return (
    <ScrollArea className="h-full">
      <div className="px-6 py-6 space-y-4 max-w-[55%] ml-auto">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} role={msg.role}>
            <p className="text-sm leading-5 text-[#f5f5f5]">{msg.content}</p>
            {msg.role === "assistant" && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => onCopy(msg)}>
                  Copy
                </Button>
                <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => onRegenerate(msg)}>
                  Regenerate
                </Button>
                <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => onLike(msg)}>
                  Like
                </Button>
              </div>
            )}
          </MessageBubble>
        ))}
      </div>
    </ScrollArea>
  );
}
