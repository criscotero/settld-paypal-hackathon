"use client";
// ADR-0024: who gets what in each milestone. Read only: the split changes with Edit team, which
// creates a version everyone approves again. The numbers come from lib/team-split.ts, where they are
// tested; this file only lays them out.
//
// Names and roles are typed by people: React renders them as text, never as HTML.
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { TriangleAlert, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { SplitCell, SplitRow, TeamSplit } from "@/lib/team-split";
import { formatWeight } from "@/lib/weights";
import { ALWAYS_HAS_ROWS, settldGridTheme } from "./grid-theme";

// The pinned total row: one sum per milestone, compared with the milestone's amount.
type TotalRow = { total: true; sums: Record<string, number>; totalMinor: number };
type Row = SplitRow | TotalRow;
const isTotal = (r: Row | undefined): r is TotalRow => r !== undefined && "total" in r;

// What every cell needs, handed through AG Grid's context so the renderers live outside the
// component and are not rebuilt on every render.
type Ctx = { split: TeamSplit; money: (amountMinor: number) => string };

function MemberCell({ data }: ICellRendererParams<Row, unknown, Ctx>) {
  if (data === undefined) return null;
  if (isTotal(data)) return <span className="font-semibold">Milestone total</span>;
  return (
    <div className="flex h-full flex-col justify-center leading-tight">
      <span className="font-medium">{data.name}</span>
      <span className="text-xs text-slate-500">
        {data.role === "" ? "No longer on the team" : data.role}
        {data.shareBps !== null && ` · ${formatWeight(data.shareBps)}%`}
      </span>
    </div>
  );
}

// Amount, and under it what PayPal already paid, or that it is only a plan.
function AmountCell({ data, colDef, context }: ICellRendererParams<Row, unknown, Ctx>) {
  const { split, money } = context;
  if (data === undefined || colDef?.colId === undefined) return null;
  const id = colDef.colId;
  if (isTotal(data)) {
    const sum = data.sums[id] ?? 0;
    const expected = split.columns.find((c) => c.id === id)?.amount.amountMinor ?? sum;
    return (
      <div className="flex h-full flex-col justify-center leading-tight">
        <span className="font-mono font-semibold">{money(sum)}</span>
        {/* Shown, never adjusted: a sum that differs from the milestone is a fact to look into. */}
        {sum !== expected && (
          <span className="inline-flex items-center gap-1 text-xs text-red-700">
            <TriangleAlert className="size-3" aria-hidden />
            Milestone is {money(expected)}
          </span>
        )}
      </div>
    );
  }
  const cell: SplitCell | undefined = data.cells[id];
  if (cell === undefined) return <span className="text-slate-400">—</span>;
  return (
    <div className="flex h-full flex-col justify-center leading-tight">
      <span className="font-mono">{money(cell.amountMinor)}</span>
      <span className="text-xs text-slate-500">{cell.planned ? "planned" : cell.paidMinor > 0 ? `paid ${money(cell.paidMinor)}` : "reserved"}</span>
    </div>
  );
}

function TotalCell({ data, context }: ICellRendererParams<Row, unknown, Ctx>) {
  const { money } = context;
  if (data === undefined) return null;
  const total = data.totalMinor;
  const paid = isTotal(data) ? null : data.paidMinor;
  return (
    <div className="flex h-full flex-col justify-center leading-tight">
      <span className="font-mono font-semibold">{money(total)}</span>
      {paid !== null && paid > 0 && <span className="text-xs text-emerald-700">paid {money(paid)}</span>}
    </div>
  );
}

export function TeamSplitGrid({ split }: { split: TeamSplit }) {
  const money = (amountMinor: number) => formatMoney({ amountMinor, currency: split.currency });

  const columns: ColDef<Row>[] = [
    // Pinned, so the name stays in view while a long contract scrolls sideways through its milestones.
    { colId: "member", headerName: "Member", cellRenderer: MemberCell, pinned: "left", width: 190 },
    ...split.columns.map(
      (c): ColDef<Row> => ({
        colId: c.id,
        headerName: `${c.code} · ${c.title}`,
        headerTooltip: `${c.code} · ${c.title} · ${money(c.amount.amountMinor)}`,
        cellRenderer: AmountCell,
        type: "rightAligned",
        // Stretch: a contract with one or two milestones fills the card instead of leaving a gap.
        flex: 1,
        minWidth: 150,
      }),
    ),
    { colId: "total", headerName: "Total", cellRenderer: TotalCell, pinned: "right", type: "rightAligned", width: 140 },
  ];

  const pinned: TotalRow[] = split.sums === null ? [] : [{ total: true, sums: split.sums, totalMinor: Object.values(split.sums).reduce((a, b) => a + b, 0) }];

  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <Users className="size-4 text-slate-400" aria-hidden /> Who gets what
        </h2>
        <p className="text-sm text-slate-500">
          {split.ownOnly
            ? "Your share only; the others' shares are private."
            : "Each member's part of every milestone. PayPal pays each one directly. To change the split, use Edit team."}
        </p>
        {split.mismatched.length > 0 && (
          <p role="alert" className="mt-1 text-sm font-medium text-red-700">
            Some milestones do not add up to their amount. Check the team before funding.
          </p>
        )}
      </div>
      <div className={ALWAYS_HAS_ROWS}>
      <AgGridReact<Row>
        theme={settldGridTheme}
        rowData={split.rows}
        columnDefs={columns}
        defaultColDef={{ sortable: false, resizable: true, wrapHeaderText: true, autoHeaderHeight: true }}
        getRowId={({ data }) => (isTotal(data) ? "total" : data.id)}
        pinnedBottomRowData={pinned}
        getRowStyle={({ data }) => (isTotal(data) ? { background: "#f8fafc" } : undefined)}
        rowHeight={52}
        domLayout="autoHeight"
        enableCellTextSelection
        context={{ split, money } satisfies Ctx}
      />
      </div>
    </Card>
  );
}
