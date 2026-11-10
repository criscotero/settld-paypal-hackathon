import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const field = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-slate-400 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-50 aria-invalid:border-red-500 aria-invalid:ring-red-500/20";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(field, "min-h-20", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(field, "h-9 py-1", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-sm font-medium text-slate-700", className)} {...props} />;
}
