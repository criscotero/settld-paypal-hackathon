import { CircleCheck, CircleX, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Small UI fragments for the home page product cards: each one shows a slice of the real
// product instead of an abstract icon. Decorative, so hidden from screen readers; the card
// text carries the meaning.

function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div aria-hidden className={cn("flex h-32 flex-col justify-center gap-2 rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200", className)}>
      {children}
    </div>
  );
}

export function CompilerArt() {
  return (
    <Frame>
      <p className="truncate rounded bg-white px-2 py-1 text-[11px] text-slate-500 ring-1 ring-slate-200">&quot;Landing page, mobile friendly, live by Friday&quot;</p>
      <div className="flex flex-wrap gap-1.5">
        {[
          ["Answers 200", "40%"],
          ["Form saves email", "30%"],
          ["Lighthouse ≥ 90", "20%"],
          ["Live by Fri", "10%"],
        ].map(([label, w]) => (
          <span key={label} className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-primary-dark">
            {label} · {w}
          </span>
        ))}
      </div>
    </Frame>
  );
}

export function LockArt() {
  return (
    <Frame className="items-start">
      <div className="flex items-center gap-2 text-xs font-semibold text-ink">
        <Lock className="size-3.5 text-primary" /> Version 3 locked
      </div>
      <p className="font-mono text-[11px] text-slate-500">sha256 9f2c…e41a</p>
      <div className="flex gap-1.5">
        <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800 ring-1 ring-emerald-200">Buyer ✓</span>
        <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800 ring-1 ring-emerald-200">Seller ✓</span>
      </div>
    </Frame>
  );
}

export function FundingArt() {
  return (
    <Frame>
      <div className="flex items-center justify-between rounded-md bg-white px-3 py-2 ring-1 ring-slate-200">
        <span className="text-xs font-semibold text-[#003087]">PayPal</span>
        <span className="font-mono text-xs font-semibold text-ink">$500.00</span>
      </div>
      <p className="flex items-center gap-1.5 text-[11px] text-slate-600">
        <span className="size-1.5 rounded-full bg-sky-500" /> Reserved on the buyer&apos;s account · not charged
      </p>
    </Frame>
  );
}

export function VerifyArt() {
  return (
    <Frame className="gap-1.5">
      {[
        ["HTTP 200 at /", true],
        ["Signup form saves email", true],
        ["Deployed before deadline", false],
      ].map(([label, ok]) => (
        <p key={String(label)} className="flex items-center gap-2 text-[11px] text-ink">
          {ok ? <CircleCheck className="size-3.5 text-emerald-600" /> : <CircleX className="size-3.5 text-red-600" />}
          {label}
        </p>
      ))}
    </Frame>
  );
}

export function ReleaseArt() {
  return (
    <Frame>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-200">
        <div className="w-[90%] bg-primary" />
        <div className="w-[10%] bg-amber-400" />
      </div>
      <div className="flex justify-between text-[11px]">
        <span className="text-slate-600">
          Released <b className="font-mono text-ink">$450.00</b>
        </span>
        <span className="text-slate-600">
          Held <b className="font-mono text-ink">$50.00</b>
        </span>
      </div>
      <p className="text-[11px] text-slate-500">Countdown 00:59 · either side can object</p>
    </Frame>
  );
}

export function SplitArt() {
  return (
    <Frame>
      <div className="grid grid-cols-3 gap-1.5">
        {[
          ["Seller", "$315"],
          ["Designer", "$90"],
          ["Copy", "$45"],
        ].map(([who, amount]) => (
          <div key={who} className="rounded-md bg-white px-2 py-1.5 text-center ring-1 ring-slate-200">
            <p className="text-[10px] text-slate-500">{who}</p>
            <p className="font-mono text-xs font-semibold text-ink">{amount}</p>
          </div>
        ))}
      </div>
      <p className="text-center text-[11px] text-slate-500">Paid by PayPal directly to each person</p>
    </Frame>
  );
}
