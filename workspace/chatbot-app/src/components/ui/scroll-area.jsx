import * as React from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({ className, children }) {
  return (
<div className={cn("relative overflow-hidden", className)}>
<div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-700 scrollbar-track-transparent">
{children}
</div>
</div>
  );
}
