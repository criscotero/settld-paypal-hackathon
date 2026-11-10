"use client";
// ADR-0022, view 4: the money about to move. One row per milestone in its objection window, with
// the time left ticking every second. When a window reaches zero the row flashes and says
// "Confirming…" while the page asks the server; once Core closes the window the row leaves the grid.
//
// Display only (constitution XII): Core's timer releases the money. Time comes from the server's
// clock (components/server-clock.tsx), the same one "Payments on the way" reads, never the browser's.
// This grid never says "Releasing…" or "Paid": only the server can.
import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Timer } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { useRefreshWhileEnded, useServerNow } from "@/components/server-clock";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { clockText, elapsedShare, newlyEnded, secondsLeft, windowTotals } from "@/lib/countdown";
import type { CountdownRow } from "@/lib/countdown";
import { formatMoney } from "@/lib/money";
import { ALWAYS_HAS_ROWS, settldGridTheme } from "./grid-theme";

// The row the grid sees: the fixed data plus what this second's clock says about it.
type Live = CountdownRow & { left: number; share: number | null };

function LeftCell({ data }: ICellRendererParams<Live>) {
  if (data === undefined) return null;
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      <span role="timer" aria-live="off" className="font-mono text-sm tabular-nums">
        {clockText(data.left)}
      </span>
      {data.share !== null && (
        <span className="block h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
          <span className={data.left < 120 ? "block h-full bg-amber-500" : "block h-full bg-primary"} style={{ width: `${String(Math.round(data.share * 100))}%` }} />
        </span>
      )}
    </div>
  );
}

function StatusCell({ data }: ICellRendererParams<Live>) {
  if (data === undefined) return null;
  return data.left > 0 ? (
    <Badge tone="warn" dot>
      Release countdown
    </Badge>
  ) : (
    // Zero on our clock is not closed on Core's: the server answers on the next refresh.
    <Badge tone="neutral" dot>
      Confirming
    </Badge>
  );
}

function MilestoneCell({ data }: ICellRendererParams<Live>) {
  if (data === undefined) return null;
  return (
    <Link href={data.href} className="font-medium text-primary hover:underline">
      {data.milestone}
    </Link>
  );
}

// The dashboard's left column is narrow: what a person scans first (time, amount, who is paid) comes
// first, and the names stretch into whatever room is left.
const COLUMNS: ColDef<Live>[] = [
  { colId: "left", headerName: "Window ends in", field: "left", cellRenderer: LeftCell, initialSort: "asc", width: 130 },
  {
    colId: "amount",
    headerName: "Amount",
    valueGetter: ({ data }) => (data === undefined ? "" : formatMoney(data.amount)),
    comparator: (_a, _b, na, nb) => (na.data && nb.data ? na.data.amount.currency.localeCompare(nb.data.amount.currency) || na.data.amount.amountMinor - nb.data.amount.amountMinor : 0),
    type: "rightAligned",
    // With its own cellClass a column loses the one "rightAligned" adds, so it is listed here too.
    cellClass: ["font-mono", "ag-right-aligned-cell"],
    width: 100,
  },
  { colId: "paidTo", headerName: "Paid to", field: "paidTo", flex: 1, minWidth: 130, tooltipField: "paidTo" },
  { colId: "milestone", headerName: "Milestone", field: "milestone", cellRenderer: MilestoneCell, flex: 1, minWidth: 130 },
  { colId: "status", headerName: "Status", valueGetter: ({ data }) => (data !== undefined && data.left > 0 ? "Release countdown" : "Confirming"), cellRenderer: StatusCell, width: 165 },
  { colId: "contract", headerName: "Contract", field: "contract", flex: 1, minWidth: 140 },
];

export function CountdownGrid({ rows, viewerIsBuyer }: { rows: CountdownRow[]; viewerIsBuyer: boolean }) {
  const now = useServerNow();
  const api = useRef<GridApi<Live> | null>(null);
  // Windows seen open, so only a window that ends while the page is open flashes. Filled on every
  // tick, not only at mount: the dashboard refreshes every 15 s and brings windows that opened later.
  const opened = useRef<Set<string>>(new Set());

  const live = useMemo<Live[]>(() => rows.map((r) => ({ ...r, left: secondsLeft(r, now), share: elapsedShare(r, now) })), [rows, now]);
  const totals = useMemo(() => windowTotals(rows, now), [rows, now]);
  // Any row at zero: ask the server, which closes the window and takes the row out of this list.
  useRefreshWhileEnded(live.some((r) => r.left === 0));

  // A window that just ended flashes once, so the money is seen moving. Not with reduced motion.
  useEffect(() => {
    const { ended, seenOpen } = newlyEnded(live, opened.current);
    opened.current = seenOpen;
    if (ended.length === 0) return;
    const grid = api.current;
    if (grid === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const nodes = ended.flatMap((id) => grid.getRowNode(id) ?? []);
    if (nodes.length > 0) grid.flashCells({ rowNodes: nodes });
  }, [live]);

  const sums = (money: { amountMinor: number; currency: string }[]) => (money.length === 0 ? "—" : money.map((m) => formatMoney(m)).join(" · "));

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <Timer className="size-4 text-slate-400" aria-hidden /> Money about to move
        </h2>
        <p className="text-sm text-slate-500">
          {viewerIsBuyer ? "What counts is released to the seller when the window ends, unless you object." : "What counts is released to you when the window ends, unless the buyer objects."}
        </p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 px-4 py-3">
          <dt className="text-xs text-slate-500">In open windows</dt>
          <dd className="font-mono text-lg font-semibold tabular-nums">{sums(totals.open)}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 px-4 py-3">
          <dt className="text-xs text-slate-500">Window ended, confirming</dt>
          <dd className="font-mono text-lg font-semibold tabular-nums">{sums(totals.releasing)}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 px-4 py-3">
          <dt className="text-xs text-slate-500">Next window ends in</dt>
          <dd className="font-mono text-lg font-semibold tabular-nums">{totals.nextEndsIn === null ? "—" : clockText(totals.nextEndsIn)}</dd>
        </div>
      </dl>
      {/* Shown only while some milestone is in its window, so it always has rows. */}
      <div className={ALWAYS_HAS_ROWS}>
      <AgGridReact<Live>
        theme={settldGridTheme}
        rowData={live}
        columnDefs={COLUMNS}
        defaultColDef={{ sortable: true, resizable: true, wrapHeaderText: true, autoHeaderHeight: true }}
        // A stable id: each second updates the rows in place instead of rebuilding them.
        getRowId={({ data }) => data.id}
        rowHeight={52}
        domLayout="autoHeight"
        onGridReady={({ api: grid }) => {
          api.current = grid;
        }}
      />
      </div>
    </Card>
  );
}
