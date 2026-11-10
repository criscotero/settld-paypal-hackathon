import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", {
  variants: {
    tone: {
      neutral: "bg-slate-50 text-slate-700 ring-slate-200",
      info: "bg-sky-50 text-sky-800 ring-sky-200",
      warn: "bg-amber-50 text-amber-800 ring-amber-200",
      good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
      bad: "bg-red-50 text-red-800 ring-red-200",
    },
  },
  defaultVariants: { tone: "neutral" },
});

const DOT = { neutral: "bg-slate-400", info: "bg-sky-500", warn: "bg-amber-500", good: "bg-emerald-500", bad: "bg-red-500" } as const;

type Props = ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { dot?: boolean };

export function Badge({ className, tone, dot = false, children, ...props }: Props) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", DOT[tone ?? "neutral"])} />}
      {children}
    </span>
  );
}
