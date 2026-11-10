"use client";
import type { ColDef, GridApi, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Check, Copy, Download, Inbox, Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { Schemas } from "@/lib/api-types";
import { compareUtcDay, CSV_COLUMNS, csvCells, entriesInView, LEDGER_VIEWS, newIds, totalsByCurrency } from "@/lib/ledger";
import type { CsvColumn, CurrencyTotal, LedgerView } from "@/lib/ledger";
import { formatMoney, toMajorString } from "@/lib/money";
import { cn } from "@/lib/utils";
import { LedgerDetail } from "./ledger-detail";
import { EFFECT_VIEW, EVENT_LABELS } from "./ledger-labels";
import { PaypalLink } from "./paypal-link";
import { settldGridTheme as theme } from "@/components/grid/grid-theme";
import { NewTabLink } from "@/components/new-tab-link";

type Entry = Schemas["LedgerEntry"];

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function EventCell({ data }: ICellRendererParams<Entry>) {
  if (data === undefined) return null;
  const effect = EFFECT_VIEW[data.ledgerEffect];
  return (
    <Badge tone={effect.tone} title={effect.label}>
      <effect.Icon className="size-3" aria-hidden />
      {EVENT_LABELS[data.type]}
    </Badge>
  );
}

function PaypalIdCell({ data }: ICellRendererParams<Entry>) {
  const [copied, setCopied] = useState(false);
  const id = data?.paypalId;
  if (id === null || id === undefined) return <span className="text-slate-400">None</span>;
  return (
    <span className="flex items-center gap-1">
      <span className="truncate font-mono text-xs">{id}</span>
      <button
        type="button"
        aria-label={copied ? "Copied" : `Copy PayPal id ${id}`}
        className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-ink"
        onClick={() => {
          // A refused clipboard (no permission, no https) just leaves the icon as it was.
          navigator.clipboard.writeText(id).then(
            () => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1500);
            },
            () => undefined,
          );
        }}
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
    </span>
  );
}

// Both receipts of a fact: Settld's, which says what it paid for, and the fact in the viewer's own
// PayPal account. Both open in a new tab (NewTabLink), so the ledger is never replaced.
function ReceiptsCell({ data }: ICellRendererParams<Entry>) {
  if (data === undefined) return null;
  return (
    <span className="flex items-center gap-3 text-sm">
      {/* Every row says "Settld", so a screen reader gets which receipt it is. */}
      <NewTabLink href={`/milestones/${data.milestoneId}/receipt`} ariaLabel={`Settld receipt for ${data.milestoneTitle}`}>
        Settld
      </NewTabLink>
      <PaypalLink url={data.paypalUrl} label="PayPal" />
    </span>
  );
}

const moneyText = (money: Entry["amount"] | undefined) => (money === null || money === undefined ? "" : formatMoney(money));
// Across currencies the order is by currency first: 100 yen and 100 dollars are not comparable.
const compareMoney = (a: Entry["amount"] | null, b: Entry["amount"] | null) => {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return a.currency.localeCompare(b.currency) || a.amountMinor - b.amountMinor;
};

// Titles and names are plain values: the grid writes them as text, never as HTML, and the only
// custom cells are React components. A title containing markup stays a title.
function columnsFor(narrow: boolean): ColDef<Entry>[] {
  // What survives a phone: date, amount, event and id. The other columns stay in the CSV. On a wide
  // screen the columns an auditor scans come first, so the PayPal id is visible without scrolling.
  const wide = (colDef: ColDef<Entry>): ColDef<Entry> => ({ ...colDef, hide: narrow });
  return [
    { colId: "date", headerName: "Date (UTC)", valueGetter: ({ data }) => (data === undefined ? null : new Date(data.occurredAt)), valueFormatter: ({ value }: ValueFormatterParams<Entry, Date>) => (value == null ? "" : dateTime.format(value)), filter: "agDateColumnFilter", filterParams: { comparator: compareUtcDay }, getQuickFilterText: ({ value }: { value: Date | null }) => (value === null ? "" : dateTime.format(value)), width: 190, initialSort: "desc" },
    wide({ colId: "contract", headerName: "Contract", field: "contractTitle", filter: "agTextColumnFilter", flex: 1, minWidth: 160 }),
    wide({ colId: "counterparty", headerName: "With", valueGetter: ({ data }) => data?.counterpartyName ?? "", filter: "agTextColumnFilter", width: 125 }),
    {
      colId: "amount",
      headerName: "Amount",
      valueGetter: ({ data }) => data?.amount ?? null,
      valueFormatter: ({ data }) => moneyText(data?.amount),
      // The value is a Money object: without this the search box would match "[object Object]".
      getQuickFilterText: ({ data }) => moneyText(data.amount),
      comparator: compareMoney,
      // Only for comparing inside the filter box: what the person typed is in major units. No total
      // ever goes through this number.
      filterValueGetter: ({ data }) => (data?.amount == null ? null : Number(toMajorString(data.amount.amountMinor, data.amount.currency))),
      filter: "agNumberColumnFilter",
      type: "rightAligned",
      // With its own cellClass a column loses the one "rightAligned" adds, so it is listed here too.
      cellClass: ["font-mono", "ag-right-aligned-cell"],
      width: 110,
    },
    { colId: "event", headerName: "Event", valueGetter: ({ data }) => (data === undefined ? "" : EVENT_LABELS[data.type]), cellRenderer: EventCell, filter: "agTextColumnFilter", width: 165 },
    // Not sortable or searchable: every row has the same two words, and the search would match them all.
    { colId: "receipts", headerName: "View receipts", cellRenderer: ReceiptsCell, sortable: false, filter: false, getQuickFilterText: () => "", width: 150 },
    { colId: "paypal_id", headerName: "PayPal id", valueGetter: ({ data }) => data?.paypalId ?? "", cellRenderer: PaypalIdCell, filter: "agTextColumnFilter", width: 170 },
    wide({ colId: "milestone", headerName: "Milestone", field: "milestoneTitle", filter: "agTextColumnFilter", width: 180 }),
    wide({ colId: "criteria", headerName: "Paid for",
      // Only a capture paid for anything: a requested or denied one names the same release and moved no money.
      valueGetter: ({ data }) => (data?.ledgerEffect === "PAID" ? data.criteria.map((c) => c.title).join(", ") : ""), filter: "agTextColumnFilter", width: 260, tooltipValueGetter: ({ value }) => value as string }),
    wide({ colId: "fee", headerName: "Fee", valueGetter: ({ data }) => data?.platformFee ?? null, valueFormatter: ({ data }) => moneyText(data?.platformFee), getQuickFilterText: ({ data }) => moneyText(data.platformFee), comparator: compareMoney, sortable: true, type: "rightAligned", cellClass: ["font-mono", "ag-right-aligned-cell"], width: 100 }),
    // Hidden, so the export can have the contract's columns (amounts in minor units) without showing them.
    { colId: "amount_minor", hide: true, lockVisible: true, suppressColumnsToolPanel: true },
    { colId: "currency", hide: true, lockVisible: true, suppressColumnsToolPanel: true },
    { colId: "platform_fee_minor", hide: true, lockVisible: true, suppressColumnsToolPanel: true },
  ];
}

const NARROW = "(max-width: 767px)";
function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

// AG Grid listens with native events on its own element, which run before React's root listener, so
// stopPropagation in a cell's button or link comes too late. The row asks where the click landed
// instead: a click on the copy button or a receipt link must not also open the detail panel.
const insideControl = (event: Event | null | undefined) => event?.target instanceof Element && event.target.closest("button, a") !== null;

export function LedgerGrid({ items, truncated }: { items: Entry[]; truncated: boolean }) {
  const api = useRef<GridApi<Entry> | null>(null);
  const [view, setView] = useState<LedgerView>("money");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [totals, setTotals] = useState<CurrencyTotal[]>([]);
  const [shown, setShown] = useState(0);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches);

  const rows = useMemo(() => entriesInView(items, view), [items, view]);
  const columns = useMemo(() => columnsFor(narrow), [narrow]);
  const selected = items.find((e) => e.id === selectedId) ?? null;

  // Totals follow what the filters leave, read from the grid so they can never disagree with it.
  const readVisible = useCallback(() => {
    const grid = api.current;
    if (grid === null) return;
    const visible: Entry[] = [];
    grid.forEachNodeAfterFilter((node) => {
      if (node.data !== undefined) visible.push(node.data);
    });
    setShown(visible.length);
    const next = totalsByCurrency(visible);
    // AG Grid fires this often; an unchanged total must not render the page again.
    setTotals((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, []);

  // A row that arrives during a refresh blinks, so the money is seen moving. Compared over all items,
  // not this view's rows, or switching views would look like new payments.
  const seen = useRef<Set<string> | null>(null);
  const pendingFlash = useRef<string[]>([]);
  // AG Grid applies new rowData on its own schedule, so the nodes may exist before or after the effect
  // below runs. This is called from both places and flashes whichever rows have a node by then.
  const flushFlash = useCallback(() => {
    const grid = api.current;
    if (grid === null || pendingFlash.current.length === 0) return;
    const rowNodes = pendingFlash.current.flatMap((id) => grid.getRowNode(id) ?? []);
    if (rowNodes.length === 0) return;
    pendingFlash.current = [];
    // flashCells only reaches cells already on screen, and a node exists a moment before its cells do.
    setTimeout(() => {
      if (!grid.isDestroyed()) grid.flashCells({ rowNodes });
    }, 50);
  }, []);
  useEffect(() => {
    const fresh = newIds(seen.current, items);
    seen.current = new Set(items.map((e) => e.id));
    if (fresh.length === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Only rows in this view: one outside it has no node, and left waiting it would flash much later,
    // when switching views, as if it had just happened.
    const inView = new Set(rows.map((e) => e.id));
    pendingFlash.current = fresh.filter((id) => inView.has(id));
    flushFlash();
  }, [items, rows, flushFlash]);

  const exportCsv = () => {
    api.current?.exportDataAsCsv({
      fileName: "settld-payments.csv",
      columnKeys: [...CSV_COLUMNS],
      processHeaderCallback: ({ column }) => column.getColId(),
      processCellCallback: ({ column, node }) => (node?.data === undefined ? "" : csvCells(node.data as Entry)[column.getColId() as CsvColumn]),
    });
  };

  if (items.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <Inbox className="size-6 text-slate-400" aria-hidden />
        <p className="text-sm text-slate-600">No payments in these dates. They appear here once PayPal confirms them.</p>
        <Link href="/contracts" className={buttonVariants({ variant: "outline" })}>
          Go to contracts
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {truncated ? (
        <Card className="flex items-start gap-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>Showing the latest 1,000 facts. Choose fewer dates to see totals: a total over part of the ledger would look complete and would not be.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-3 sm:grid-cols-2">
            {totals.length === 0 && <Card className="p-4 text-sm text-slate-500 sm:col-span-2">No money moved in the rows shown.</Card>}
            {totals.flatMap((t) => [
              <Card key={`${t.currency}-paid`} className="p-4">
                <p className="text-xs font-medium text-slate-500">Paid · {t.currency}</p>
                <p className="mt-1 font-mono text-2xl font-semibold">{formatMoney({ amountMinor: t.paidMinor, currency: t.currency })}</p>
              </Card>,
              <Card key={`${t.currency}-returned`} className="p-4">
                <p className="text-xs font-medium text-slate-500">Returned · {t.currency}</p>
                <p className="mt-1 font-mono text-2xl font-semibold">{formatMoney({ amountMinor: t.returnedMinor, currency: t.currency })}</p>
              </Card>,
            ])}
          </div>
          <p className="text-xs text-slate-500">Totals follow your filters and count only what PayPal confirmed, so a return in progress may not be here yet.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Which facts to show" className="flex flex-wrap gap-1">
          {LEDGER_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => {
                setView(v.id);
              }}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium transition-colors", view === v.id ? "bg-navy text-white" : "text-slate-600 hover:bg-slate-100")}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <div className="relative min-w-52 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              aria-label="Search the ledger"
              placeholder="Contract, name, PayPal id"
              className="pl-9"
            />
          </div>
          <Button variant="outline" onClick={exportCsv} disabled={shown === 0}>
            <Download className="size-4" aria-hidden />
            Export CSV
          </Button>
        </div>
      </div>

      <div className={cn("grid gap-4", selected !== null && "items-start lg:grid-cols-[minmax(0,1fr)_340px]")}>
        <div className="h-[560px] min-w-0">
          <AgGridReact<Entry>
            theme={theme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: false }}
            // A stable id is what makes the 5-second refresh invisible: the grid updates the rows it
            // knows instead of rebuilding them, so filters, scroll and the open detail all survive.
            getRowId={({ data }) => data.id}
            quickFilterText={search}
            animateRows={false}
            enableCellTextSelection
            onGridReady={({ api: grid }) => {
              api.current = grid;
              readVisible();
            }}
            onModelUpdated={readVisible}
            onRowDataUpdated={flushFlash}
            onRowClicked={({ data, event }) => {
              if (!insideControl(event)) setSelectedId(data?.id ?? null);
            }}
            onCellKeyDown={({ data, event }) => {
              if ((event as KeyboardEvent | null | undefined)?.key === "Enter" && !insideControl(event)) setSelectedId(data?.id ?? null);
            }}
            overlayNoRowsTemplate="No rows match these filters."
          />
        </div>
        {selected !== null && (
          <LedgerDetail
            entry={selected}
            onClose={() => {
              setSelectedId(null);
            }}
          />
        )}
      </div>
      <p className="text-xs text-slate-500">
        {shown} of {items.length} facts shown. Select a row to see what it paid for.
      </p>
    </div>
  );
}
