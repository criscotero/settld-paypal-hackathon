// What PayPal has paid, over time and by counterparty. One series each, so no legend: the title says
// what is plotted. Server-rendered, with CSS for the hover, so it works before hydration, and every
// value is also in the table under each chart. Same teal as the money bar (validated, dataviz).
import { Card } from "@/components/ui/card";
import { niceCeiling } from "@/lib/dashboard";
import type { PaidHistory } from "@/lib/dashboard";
import { formatMoney } from "@/lib/money";

export interface ChartLabels {
  months: string;
  parties: string;
  noun: string;
}

const BAR = "bg-[#0d9488]";

function Tooltip({ children }: { children: string }) {
  return (
    <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 rounded-md bg-navy px-2.5 py-1.5 text-xs whitespace-nowrap text-white group-hover:block group-focus-visible:block">
      {children}
    </span>
  );
}

function TableView({ caption, first, rows }: { caption: string; first: string; rows: [string, string][] }) {
  return (
    <details className="mt-3 text-xs text-slate-500">
      <summary className="cursor-pointer select-none hover:text-ink">View as table</summary>
      <table className="mt-2 w-full">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left">
            <th className="py-1 font-medium">{first}</th>
            <th className="py-1 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-slate-700">
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-1">{k}</td>
              <td className="py-1 text-right font-mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Months({ history, title }: { history: PaidHistory; title: string }) {
  const money = (amountMinor: number) => formatMoney({ amountMinor, currency: history.currency });
  const peak = Math.max(...history.months.map((m) => m.amount));
  const top = niceCeiling(peak);
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-slate-500">Last {history.months.length} months</p>
      </div>
      <figure className="mt-5 grid grid-cols-[auto_1fr] gap-x-3">
        <div aria-hidden className="flex h-44 flex-col justify-between text-right font-mono text-xs text-slate-400">
          <span className="-translate-y-1/2">{money(top)}</span>
          <span>{money(Math.round(top / 2))}</span>
          <span className="translate-y-1/2">{money(0)}</span>
        </div>
        <div className="relative h-44 border-b border-slate-200">
          <span aria-hidden className="absolute inset-x-0 top-0 border-t border-slate-100" />
          <span aria-hidden className="absolute inset-x-0 top-1/2 border-t border-slate-100" />
          <div className="absolute inset-0 flex items-end justify-around">
            {history.months.map((m) => (
              // The hit target is the whole column, wider than the bar, and it takes the keyboard.
              <div key={m.key} tabIndex={0} aria-label={`${m.label}: ${money(m.amount)}`} className="group relative flex h-full flex-1 items-end justify-center outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {m.amount > 0 && <span className={`relative w-full max-w-6 rounded-t ${BAR}`} style={{ height: `${String((m.amount / top) * 100)}%` }}>
                  {/* Only the peak carries its value: the axis and the table have the rest. */}
                  {m.amount === peak && <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 font-mono text-xs font-semibold whitespace-nowrap text-ink">{money(m.amount)}</span>}
                </span>}
                <Tooltip>{`${money(m.amount)} · ${m.label}`}</Tooltip>
              </div>
            ))}
          </div>
        </div>
        <span />
        <div aria-hidden className="mt-1.5 flex justify-around text-xs text-slate-500">
          {history.months.map((m) => (
            <span key={m.key} className="flex-1 text-center">
              {m.label}
            </span>
          ))}
        </div>
      </figure>
      <TableView caption={title} first="Month" rows={history.months.map((m) => [m.label, money(m.amount)])} />
    </Card>
  );
}

function Parties({ history, title, noun }: { history: PaidHistory; title: string; noun: string }) {
  const money = (amountMinor: number) => formatMoney({ amountMinor, currency: history.currency });
  const top = history.byParty[0]?.amount ?? 1;
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">
        <span className="font-mono font-semibold text-ink">{money(history.total)}</span> {noun} in total
      </p>
      <ul className="mt-4 space-y-3">
        {history.byParty.map((p) => (
          <li key={p.name} tabIndex={0} aria-label={`${p.name}: ${money(p.amount)}`} className="group relative text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-slate-700">{p.name}</span>
              <span className="shrink-0 font-mono font-semibold">{money(p.amount)}</span>
            </div>
            <div className="mt-1 h-2 rounded-r bg-slate-100">
              <div className={`h-2 rounded-r ${BAR}`} style={{ width: `${String((p.amount / top) * 100)}%` }} />
            </div>
            <Tooltip>{`${money(p.amount)} · ${String(Math.round((p.amount / history.total) * 100))}%`}</Tooltip>
          </li>
        ))}
      </ul>
      <TableView caption={title} first="Name" rows={history.byParty.map((p) => [p.name, money(p.amount)])} />
    </Card>
  );
}

export function PaidCharts({ history, labels }: { history: PaidHistory; labels: ChartLabels }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Months history={history} title={labels.months} />
      <Parties history={history} title={labels.parties} noun={labels.noun} />
    </div>
  );
}
