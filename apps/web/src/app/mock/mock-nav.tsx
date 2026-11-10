"use client";
import { FlaskConical, RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMock } from "./store";

const TABS = [
  { href: "/mock", label: "Overview" },
  { href: "/mock/profile", label: "1 · Profile" },
  { href: "/mock/team", label: "2 · Team" },
  { href: "/mock/contract", label: "3 · Live contract" },
  { href: "/mock/receipt", label: "4 · Receipt" },
];

export function MockNav() {
  const path = usePathname();
  const { reset } = useMock();
  return (
    <div className="space-y-3">
      <p role="note" className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
        <FlaskConical className="size-4 shrink-0" aria-hidden />
        Prototype with made-up data. Nothing here is saved to Settld or moves money; it lives in this browser only.
      </p>
      <nav aria-label="Prototype" className="flex flex-wrap items-center gap-1 border-b border-slate-200 pb-2">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={path === t.href ? "page" : undefined}
            className={cn("rounded-md px-3 py-1.5 text-sm font-medium", path === t.href ? "bg-accent-soft text-primary" : "text-slate-600 hover:bg-slate-100")}
          >
            {t.label}
          </Link>
        ))}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
          <RotateCcw aria-hidden /> Start over
        </Button>
      </nav>
    </div>
  );
}
