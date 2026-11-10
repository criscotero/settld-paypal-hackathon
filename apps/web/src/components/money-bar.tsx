import type { MoneyBuckets } from "@/lib/dashboard";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

// Ordinal one-hue teal ramp, dark = settled (dataviz: ordered stages take a sequential
// ramp, not categorical hues). Validated with the dataviz palette script: adjacent
// steps separate for normal and color-blind vision; the light step is below 3:1
// contrast, so every segment also has a visible label with its value (the legend).
const SEGMENTS = [
  { key: "paid", color: "bg-[#134e4a]" },
  { key: "reserved", color: "bg-[#0d9488]" },
  { key: "unfunded", color: "bg-[#5eead4]" },
] as const;

export type SegmentLabels = Record<(typeof SEGMENTS)[number]["key"], string>;

export function MoneyBar({ buckets, labels }: { buckets: MoneyBuckets; labels: SegmentLabels }) {
  const total = buckets.paid + buckets.reserved + buckets.unfunded;
  const money = (amountMinor: number) => formatMoney({ amountMinor, currency: buckets.currency });
  return (
    <figure className="space-y-4">
      <div className="flex items-baseline justify-between">
        <figcaption className="text-sm text-slate-500">Total in {buckets.currency}</figcaption>
        <span className="font-mono text-lg font-semibold">{money(total)}</span>
      </div>
      {/* 2px surface gaps between segments; rounded only at the two ends. */}
      <div className="flex h-4 gap-0.5 overflow-visible">
        {SEGMENTS.filter((s) => buckets[s.key] > 0).map((s, i, shown) => {
          const share = buckets[s.key] / total;
          return (
            <div
              key={s.key}
              tabIndex={0}
              aria-label={`${labels[s.key]}: ${money(buckets[s.key])}, ${String(Math.round(share * 100))}%`}
              style={{ width: `${String(share * 100)}%` }}
              className={cn(
                "group relative min-w-1 outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                s.color,
                i === 0 && "rounded-l-md",
                i === shown.length - 1 && "rounded-r-md",
              )}
            >
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 rounded-md bg-navy px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg group-hover:block group-focus-visible:block"
              >
                {labels[s.key]} · <span className="font-mono">{money(buckets[s.key])}</span> · {Math.round(share * 100)}%
              </span>
            </div>
          );
        })}
      </div>
      {/* Legend doubles as the table view: label, exact amount and share, in text tokens. */}
      <dl className="space-y-2">
        {SEGMENTS.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-sm">
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-sm", s.color)} />
            <dt className="flex-1 text-slate-600">{labels[s.key]}</dt>
            <dd className="font-mono font-semibold">{money(buckets[s.key])}</dd>
            <dd className="w-9 text-right text-xs text-slate-400">{total === 0 ? "" : `${String(Math.round((buckets[s.key] / total) * 100))}%`}</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}
