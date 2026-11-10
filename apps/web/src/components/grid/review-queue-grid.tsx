"use client";
// ADR-0022, view 5: the reviewer's queue. The money of each case stays reserved in PayPal until a
// ruling, so the oldest case is first and turns amber after two days and red after three.
//
// The buyer's reason and the names are typed by people: React renders them as text, never as HTML.
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { ChevronRight, Clock, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
import { heldTotals, waitingText, waitingTone } from "@/lib/review-queue";
import type { ReviewRow } from "@/lib/review-queue";
import { settldGridTheme } from "./grid-theme";

type Row = ReviewRow | TotalRow;
type TotalRow = { total: true; text: string; count: number };
const isTotal = (r: Row | undefined): r is TotalRow => r !== undefined && "total" in r;

function WaitingCell({ data }: ICellRendererParams<Row>) {
  if (data === undefined || isTotal(data)) return null;
  const tone = waitingTone(data.waitingMs);
  return (
    <Badge tone={tone} dot={tone !== "neutral"}>
      <Clock className="size-3" aria-hidden />
      {waitingText(data.waitingMs)}
    </Badge>
  );
}

function OpenCell({ data }: ICellRendererParams<Row>) {
  if (data === undefined || isTotal(data)) return null;
  return (
    <Link href={data.href} className={buttonVariants({ variant: "outline", size: "sm" })}>
      Open case
      <ChevronRight aria-hidden />
    </Link>
  );
}

const money = (r: Row | undefined) => (r === undefined || isTotal(r) ? "" : formatMoney(r.amount));

const COLUMNS: ColDef<Row>[] = [
  { colId: "case", headerName: "Case", valueGetter: ({ data }) => (data === undefined || isTotal(data) ? "" : data.caseRef), tooltipValueGetter: ({ data }) => (data === undefined || isTotal(data) ? undefined : data.id), cellClass: "font-mono", width: 110 },
  { colId: "waiting", headerName: "Waiting", valueGetter: ({ data }) => (data === undefined || isTotal(data) ? null : data.waitingMs), cellRenderer: WaitingCell, initialSort: "desc", width: 130, getQuickFilterText: () => "" },
  { colId: "milestone", headerName: "Milestone", valueGetter: ({ data }) => (data === undefined || isTotal(data) ? `${String(data?.count ?? 0)} ${data?.count === 1 ? "case" : "cases"}` : data.milestone), flex: 1, minWidth: 170 },
  { colId: "contract", headerName: "Contract", valueGetter: ({ data }) => (data === undefined || isTotal(data) ? "" : data.contract), flex: 1, minWidth: 170 },
  {
    colId: "held",
    headerName: "Held in PayPal",
    valueGetter: ({ data }) => (data === undefined ? "" : isTotal(data) ? data.text : money(data)),
    // Currency first: 100 yen and 100 dollars are not comparable.
    comparator: (_a, _b, na, nb) => {
      const a = na.data, b = nb.data;
      if (a === undefined || b === undefined || isTotal(a) || isTotal(b)) return 0;
      return a.amount.currency.localeCompare(b.amount.currency) || a.amount.amountMinor - b.amount.amountMinor;
    },
    type: "rightAligned",
    // With its own cellClass a column loses the one "rightAligned" adds, so it is listed here too.
    cellClass: ["font-mono", "ag-right-aligned-cell"],
    // Wide enough for the total row, which lists one sum per currency.
    width: 200,
  },
  { colId: "reason", headerName: "Buyer's reason", valueGetter: ({ data }) => (data === undefined || isTotal(data) ? "" : data.reason), flex: 2, minWidth: 240, tooltipValueGetter: ({ value }) => value as string },
  { colId: "buyer", headerName: "Buyer", valueGetter: ({ data }) => (data === undefined || isTotal(data) ? "" : data.buyer), width: 140 },
  { colId: "seller", headerName: "Seller", valueGetter: ({ data }) => (data === undefined || isTotal(data) ? "" : data.seller), width: 140 },
  { colId: "open", headerName: "", cellRenderer: OpenCell, sortable: false, width: 130, getQuickFilterText: () => "" },
];

export function ReviewQueueGrid({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState<ReviewRow[]>(rows);
  // The pinned row adds what the search leaves, read from the grid so the two can never disagree.
  const pinned = useMemo<TotalRow[]>(() => [{ total: true, count: visible.length, text: heldTotals(visible).map((m) => formatMoney(m)).join(" · ") || formatMoney({ amountMinor: 0, currency: "USD" }) }], [visible]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
            placeholder="Contract, party, reason"
            aria-label="Search the queue"
            className="pl-9"
          />
        </div>
        <p className="text-sm text-slate-500">
          {visible.length} of {rows.length} {rows.length === 1 ? "case" : "cases"}
        </p>
      </div>
      <AgGridReact<Row>
        theme={settldGridTheme}
        rowData={rows}
        columnDefs={COLUMNS}
        defaultColDef={{ sortable: true, resizable: true }}
        getRowId={({ data }) => (isTotal(data) ? "total" : data.id)}
        pinnedBottomRowData={pinned}
        quickFilterText={search}
        domLayout="autoHeight"
        enableCellTextSelection
        getRowStyle={({ data }) => (isTotal(data) ? { fontWeight: 600, background: "#f8fafc" } : undefined)}
        onModelUpdated={({ api }) => {
          const next: ReviewRow[] = [];
          api.forEachNodeAfterFilter((n) => {
            if (n.data !== undefined && !isTotal(n.data)) next.push(n.data);
          });
          setVisible((current) => (current.length === next.length && current.every((r, i) => r.id === next[i]?.id) ? current : next));
        }}
        onRowClicked={({ data, event }) => {
          // The button already navigates; a click elsewhere on the row opens the case too.
          if (data === undefined || isTotal(data) || (event?.target instanceof Element && event.target.closest("a") !== null)) return;
          router.push(data.href);
        }}
        overlayNoRowsTemplate="No cases match this search."
      />
    </div>
  );
}
