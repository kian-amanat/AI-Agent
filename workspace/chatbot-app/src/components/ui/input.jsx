import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef(function Input(
  { className, type = "text", ...props },
  ref
) {
  return (
<input
type={type}
ref={ref}
className={cn(
"flex h-9 w-full rounded-md border border-[#272727] bg-neutral-900 px-3 py-1 text-sm text-neutral-100 shadow-sm outline-none ring-offset-neutral-900 placeholder:text-neutral-500 focus-visible:ring-2 focus-visible:ring-[#fb7185] focus-visible:ring-offset-2",
className
)}
{...props}
/>
  );
});
