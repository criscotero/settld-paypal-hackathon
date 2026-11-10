import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// shadcn/ui Button, trimmed to the variants we use, plus a loading state.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-navy text-white shadow-sm hover:bg-navy/90",
        primary: "bg-primary text-white shadow-sm hover:bg-primary-dark",
        outline: "border border-slate-300 bg-white text-ink shadow-sm hover:bg-slate-50",
        ghost: "text-slate-600 hover:bg-slate-100 hover:text-ink",
        destructive: "bg-red-600 text-white shadow-sm hover:bg-red-700",
      },
      size: { default: "h-9 px-4", sm: "h-8 px-3 text-xs", lg: "h-11 px-6 text-base" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type Props = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { loading?: boolean };

export function Button({ className, variant, size, loading = false, disabled, children, ...props }: Props) {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} disabled={disabled ?? loading} aria-busy={loading || undefined} {...props}>
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
