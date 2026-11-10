"use client";
// ADR-0022, view 1: what the AI checked, one row per check, and the evidence behind the selected
// one. It only reads: the buyer still approves or objects with the buttons below it.
//
// Every text in a row was written by a model that read the seller's content. React renders it as
// text; no cell uses innerHTML, so a delivery that contains markup shows the markup, never runs it.
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { CircleCheck, CircleHelp, CircleX, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { auditCounts, evidenceLabel } from "@/lib/ai-audit";
import type { AuditRow } from "@/lib/ai-audit";
import { cn } from "@/lib/utils";
import type { CheckTone } from "@/lib/verdict";
import { settldGridTheme } from "./grid-theme";

type Filter = "all" | CheckTone;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All checks" },
  { id: "not-met", label: "Not met" },
  { id: "unsure", label: "Not sure" },
  { id: "met", label: "Met" },
];

// Words and an icon for every verdict, never color alone (constitution XII).
const TONE_VIEW: Record<CheckTone, { tone: "good" | "bad" | "neutral"; Icon: typeof CircleCheck }> = {
  met: { tone: "good", Icon: CircleCheck },
  "not-met": { tone: "bad", Icon: CircleX },
  unsure: { tone: "neutral", Icon: CircleHelp },
};
// Worst first, so what the seller must fix and what the buyer must judge is at the top.
const SEVERITY: Record<CheckTone, number> = { "not-met": 3, unsure: 2, met: 1 };

function VerdictCell({ data }: ICellRendererParams<AuditRow>) {
  if (data === undefined) return null;
  const { tone, Icon } = TONE_VIEW[data.tone];
  return (
    <Badge tone={tone}>
      <Icon className="size-3" aria-hidden />
      {data.label}
    </Badge>
  );
}

function InjectionCell({ data }: ICellRendererParams<AuditRow>) {
  if (data === undefined) return null;
  return data.injection.length > 0 ? (
    <span className="inline-flex items-center gap-1 font-semibold text-red-800">
      <ShieldAlert className="size-3.5" aria-hidden />
      Flagged
    </span>
  ) : (
    <span className="text-slate-400">None</span>
  );
}

const readText = (r: AuditRow) => [...new Set(r.evidence.map((e) => evidenceLabel(e.kind)))].join(", ") || "Nothing cited";
const sourceText = (r: AuditRow) => [...new Set(r.evidence.map((e) => e.sourceUrl).filter((u) => u !== null))].join(", ");

const COLUMNS: ColDef<AuditRow>[] = [
  // First: the code the buyer saw in the editor, so "M1-C2" means one criterion everywhere. No id
  // column: a UUID helps nobody scan; the full id is in the detail panel, with a copy button.
  { colId: "code", headerName: "Code", field: "code", width: 90, cellClass: "font-mono", pinned: "left" },
  { colId: "verdict", headerName: "Verdict", valueGetter: ({ data }) => (data === undefined ? 0 : SEVERITY[data.tone]), cellRenderer: VerdictCell, initialSort: "desc", width: 130, getQuickFilterText: ({ data }) => data.label },
  { colId: "requirement", headerName: "Check", field: "requirement", flex: 2, minWidth: 220, tooltipField: "requirement" },
  { colId: "criterion", headerName: "Criterion", field: "criterionText", flex: 1, minWidth: 170, tooltipField: "criterionText" },
  { colId: "read", headerName: "Read", valueGetter: ({ data }) => (data === undefined ? "" : readText(data)), width: 150 },
  { colId: "source", headerName: "Source", valueGetter: ({ data }) => (data === undefined ? "" : sourceText(data)), width: 200, tooltipValueGetter: ({ value }) => value as string },
  { colId: "injection", headerName: "Injection", valueGetter: ({ data }) => data?.injection.length ?? 0, cellRenderer: InjectionCell, width: 110 },
];

function Detail({ row }: { row: AuditRow | null }) {
  if (row === null) return <p className="text-sm text-slate-500">Select a check to see what the AI quoted, what it found and what it read.</p>;
  const { tone, Icon } = TONE_VIEW[row.tone];
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1.5">
        <h4 className="font-semibold break-words">{row.requirement}</h4>
        <Badge tone={tone}>
          <Icon className="size-3" aria-hidden />
          {row.label}
        </Badge>
      </div>
      <Field label="Criterion">
        <span className="font-mono text-xs font-semibold text-slate-500">{row.code}</span> {row.criterionText}
        <span className="mt-1 flex items-center gap-1 font-mono text-[11px] break-all text-slate-400">
          {row.criterionId}
          <CopyButton value={row.criterionId} label="Copy criterion id" />
        </span>
      </Field>
      {row.sourceExcerpt !== "" && <Field label="From the agreement">“{row.sourceExcerpt}”</Field>}
      <Field label="What the AI found">{row.finding}</Field>
      {row.fix !== null && <Field label="What the seller must fix">{row.fix}</Field>}
      {row.note !== null && <Field label="Why the check changed">{row.note}</Field>}
      {row.injection.map((f) => (
        <p key={`${f.kind}-${f.excerpt}`} className="flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200 ring-inset">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">Possible manipulation. Found in the evidence: “{f.excerpt}”</span>
        </p>
      ))}
      <Field label="What it read">
        {row.evidence.length === 0 ? (
          "Nothing cited"
        ) : (
          <ul className="space-y-2">
            {row.evidence.map((e) => (
              <li key={e.snapshotId} className="min-w-0">
                <span className="font-medium">{evidenceLabel(e.kind)}</span>
                {e.sourceUrl !== null && <span className="block break-all text-slate-600">{e.sourceUrl}</span>}
                {/* The hash of what the AI read, frozen before it read it (ADR-0019): anyone can check it later. */}
                <span className="block font-mono text-[11px] break-all text-slate-400">SHA-256 {e.hash}</span>
              </li>
            ))}
          </ul>
        )}
      </Field>
      <p className="text-xs text-slate-500">This is the AI&apos;s opinion. It only counts toward the payment if the buyer approves it.</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <div className="mt-0.5 break-words text-slate-700">{children}</div>
    </div>
  );
}

// checking: the run is still in progress, so more checks may appear (the page refreshes every 5 s).
export function AiAuditGrid({ rows, checking = false }: { rows: AuditRow[]; checking?: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const counts = useMemo(() => auditCounts(rows), [rows]);
  const shown = useMemo(() => (filter === "all" ? rows : rows.filter((r) => r.tone === filter)), [rows, filter]);
  // From what the filter shows, not from every row: the panel must never describe a check the grid hides.
  const selected = shown.find((r) => r.id === selectedId) ?? null;

  return (
    <section aria-label="What the AI checked" className="@container space-y-3 rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">What the AI checked</h4>
          {checking && (
            <p role="status" className="text-xs font-medium text-amber-800">
              Checking… More checks may appear while the AI reads the delivery.
            </p>
          )}
          <p className="text-xs text-slate-500">
            {counts.met} met · {counts.notMet} not met · {counts.unsure} not sure · {counts.read} {counts.read === 1 ? "page or file" : "pages and files"} read
          </p>
        </div>
        <div role="group" aria-label="Filter checks" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
              }}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium transition-colors", filter === f.id ? "bg-navy text-white" : "text-slate-600 hover:bg-slate-100")}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {/* By the section's width, not the screen's: on the contract page it sits in the main column next
          to the sidebar, and a side panel there left the grid with two columns. Below 48rem the panel
          goes under the grid. */}
      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          <AgGridReact<AuditRow>
            theme={settldGridTheme}
            rowData={shown}
            columnDefs={COLUMNS}
            defaultColDef={{ sortable: true, resizable: true }}
            // A stable id keeps the selection and the scroll when the contract page refreshes.
            getRowId={({ data }) => data.id}
            domLayout="autoHeight"
            enableCellTextSelection
            onRowClicked={({ data }) => {
              setSelectedId(data?.id ?? null);
            }}
            onCellKeyDown={({ data, event }) => {
              if ((event as KeyboardEvent | null | undefined)?.key === "Enter") setSelectedId(data?.id ?? null);
            }}
            // Important (!): AG Grid paints rows with its own background, which would win over a plain class.
            rowClassRules={{ "bg-red-50!": ({ data }) => (data?.injection.length ?? 0) > 0, "bg-accent-soft!": ({ data }) => data?.id === selectedId }}
            overlayNoRowsTemplate="No checks match this filter."
          />
        </div>
        <aside aria-live="polite" className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <Detail row={selected} />
        </aside>
      </div>
    </section>
  );
}
