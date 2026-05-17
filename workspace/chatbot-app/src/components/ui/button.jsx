import * as React from "react";
import { cn } from "@/lib/utils";

export function Button({ className, variant = "default", size = "default", ...props }) {
  const base =
"inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ring-offset-neutral-900 disabled:pointer-events-none disabled:opacity-50 cursor-pointer";
  const variants = {
default: "bg-[#fb7185] text-white hover:bg-[#f9738f]",
ghost: "bg-transparent hover:bg-white/5 text-neutral-200",
outline: "border border-[#272727] bg-transparent hover:bg-white/5 text-neutral-200",
subtle: "bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
secondary: "bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
  };
  const sizes = {
default: "h-9 px-4 py-2",
sm: "h-8 px-3",
lg: "h-10 px-6",
icon: "h-9 w-9",
xs: "h-7 px-2 text-xs",
  };
  return (
<button
type={props.type || "button"}
className={cn(base, variants[variant], sizes[size], className)}
{...props}
/>
  );
}
