"use client";
// ADR-0022, view 2: a milestone's criteria as an editable grid. It is a second view over the same
// form state as the cards in draft-form.tsx, never a copy: every edit returns false to AG Grid (so
// the grid does not change the row in place) and goes through the form's own setCriterion. What is
// submitted is always what the form holds, whichever view the buyer used.
import type { ColDef, ICellRendererParams, ValueSetterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { CircleAlert, CircleCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CHECK_CHOICES, checkChoiceOf, pageToReadOf, patchForChoice, patchForPageToRead, patchForSetting, rowIssues, settingLabel, settingOf } from "@/lib/criteria-grid";
import type { CriterionFields } from "@/lib/criteria-grid";
import { ALWAYS_HAS_ROWS, settldGridTheme } from "./grid-theme";

// An editor hands back what was typed, or null when the cell was cleared.
const asText = (v: unknown): string => (typeof v === "string" ? v : "");

// Wrapped cells read as text, not as rows of the grid's tall single-line height. AG Grid's wrapText
// sets white-space: normal, which folds a typed line break into a space: pre-wrap keeps the lines the
// buyer wrote. wrap-anywhere breaks a long URL, which has no spaces and would run under the next cell.
const WRAPPED = "leading-5! py-2! whitespace-pre-wrap! wrap-anywhere";
// The cells' "nothing here" voice, the same in the "What to check" and "Page to read" columns.
const EMPTY = "text-slate-400 italic";

export type GridCriterion = CriterionFields & { rationale?: string | undefined };
type Patch = Partial<Pick<CriterionFields, "text" | "level" | "checkType" | "probeUrl" | "guidance" | "weight" | "required">>;

type Props = {
  criteria: GridCriterion[];
  // "M1-C2" by form key, from the form (lib/criterion-code.ts), so the cards and the grid never differ.
  codes: ReadonlyMap<number, string>;
  // Hands the form a "finish the open edit" for its submit, and null when the grid goes away.
  registerFlush: (flush: (() => boolean) | null) => void;
  onChange: (key: number, patch: Patch) => void;
  // Null while the milestone has one criterion: a milestone needs at least one.
  onRemove: ((key: number) => void) | null;
};

// The criterion, and under it the compiler's reason, in sight like in the cards: a tooltip is easy to
// miss and never shows on a touch screen. The editor still edits only the text (the valueGetter).
function CriterionCell({ data, value }: ICellRendererParams<GridCriterion, string>) {
  if (data === undefined) return null;
  return (
    <div>
      <span>{value}</span>
      {data.rationale !== undefined && data.rationale !== "" && <span className="mt-1 block text-xs text-slate-500">Why: {data.rationale}</span>}
    </div>
  );
}

// An icon with words for screen readers and a tooltip, so the grid fits the form's column.
function StatusCell({ data }: ICellRendererParams<GridCriterion>) {
  if (data === undefined) return null;
  const issues = rowIssues(data);
  const text = issues.length === 0 ? "Ready" : issues.join(". ");
  return (
    <span title={text} className="flex h-full items-center">
      {issues.length === 0 ? <CircleCheck className="size-4 text-emerald-700" aria-hidden /> : <CircleAlert className="size-4 text-red-700" aria-hidden />}
      <span className="sr-only">{text}</span>
    </span>
  );
}

export function CriteriaGrid({ criteria, codes, onChange, onRemove, registerFlush }: Props) {
  // Never mutate: hand the change to the form and tell AG Grid nothing changed here.
  const set = (patch: (c: GridCriterion, value: unknown) => Patch | null) => (p: ValueSetterParams<GridCriterion>) => {
    const next = patch(p.data, p.newValue);
    if (next !== null) onChange(p.data.key, next);
    return false;
  };

  const columns: ColDef<GridCriterion>[] = [
    // First, like in the cards. Not editable: it is the criterion's place, not something to type.
    { colId: "code", headerName: "Code", valueGetter: ({ data }) => (data === undefined ? "" : (codes.get(data.key) ?? "")), headerTooltip: "Criterion code. It changes while the draft is edited.", cellClass: "font-mono text-slate-500", width: 76 },
    {
      colId: "text",
      headerName: "What counts as done",
      valueGetter: ({ data }) => data?.text ?? "",
      valueSetter: set((_c, v) => ({ text: asText(v) })),
      editable: true,
      // A popup with room for all 500 characters: the in-cell editor is one line as wide as the
      // column, so a long criterion scrolled out of sight while it was being edited.
      cellEditor: "agLargeTextCellEditor",
      cellEditorPopup: true,
      cellEditorParams: { maxLength: 500, rows: 4, cols: 50 },
      // The compiler's reason stays visible until the buyer edits the criterion, like in the cards.
      cellRenderer: CriterionCell,
      cellClassRules: { "bg-red-50!": ({ data }) => data !== undefined && data.text.trim() === "" },
      // Wrapped, not cut: the buyer must see the whole criterion they are agreeing to. It gets the
      // most room, and a floor so it never shrinks to a word per line: below it the grid scrolls.
      wrapText: true,
      autoHeight: true,
      cellClass: WRAPPED,
      flex: 3,
      minWidth: 200,
    },
    {
      colId: "check",
      headerName: "Check",
      valueGetter: ({ data }) => (data === undefined ? "" : checkChoiceOf(data)),
      valueSetter: set((_c, v) => patchForChoice(String(v))),
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: CHECK_CHOICES.map((c) => c.label) },
      wrapText: true,
      autoHeight: true,
      cellClass: WRAPPED,
      width: 140,
    },
    {
      colId: "setting",
      headerName: "What to check",
      valueGetter: ({ data }) => (data === undefined ? "" : settingOf(data)),
      valueFormatter: ({ data, value }) => {
        if (data === undefined) return "";
        const label = settingLabel(data);
        if (label === null) return "The buyer decides";
        return (value as string) === "" ? `Add: ${label}` : (value as string);
      },
      valueSetter: set((c, v) => patchForSetting(c, asText(v))),
      editable: ({ data }) => data !== undefined && settingLabel(data) !== null,
      // Guidance can be long: a popup editor with room for it. The URL fits in the cell.
      cellEditorSelector: ({ data }) => (data.level === "AI_EVALUATED" ? { component: "agLargeTextCellEditor", popup: true, params: { maxLength: 2000, rows: 6, cols: 50 } } : { component: "agTextCellEditor", params: { maxLength: 2048 } }),
      cellClassRules: { [EMPTY]: ({ data }) => data !== undefined && settingOf(data) === "" },
      wrapText: true,
      autoHeight: true,
      cellClass: WRAPPED,
      flex: 2,
      minWidth: 160,
    },
    {
      // In the cards since the AI check exists; the grid left it out, so a buyer who switched views
      // could not see which page the AI would read. Same field (probeUrl), same empty meaning.
      colId: "pageToRead",
      headerName: "Page to read",
      headerTooltip: "The page the AI check reads. Empty: the link in the seller's delivery.",
      valueGetter: ({ data }) => (data === undefined ? null : pageToReadOf(data)),
      valueFormatter: ({ value }) => {
        if (value === null) return "Not used";
        return (value as string) === "" ? "The link in the delivery" : (value as string);
      },
      valueSetter: set((c, v) => patchForPageToRead(c, asText(v))),
      editable: ({ data }) => data !== undefined && pageToReadOf(data) !== null,
      cellEditor: "agTextCellEditor",
      cellEditorParams: { maxLength: 2048 },
      cellClassRules: { [EMPTY]: ({ value }) => value === null || value === "" },
      wrapText: true,
      autoHeight: true,
      cellClass: WRAPPED,
      // A URL is worth reading whole, but a wide column of "Not used" would push the criterion aside.
      flex: 1,
      minWidth: 130,
      maxWidth: 240,
    },
    {
      colId: "weight",
      headerName: "Weight %",
      headerTooltip: "Each criterion pays its weight when it is met. Weights must add up to 100%.",
      // Kept as typed ("33.34"), like the cards; it becomes basis points only on submit.
      valueGetter: ({ data }) => data?.weight ?? "",
      valueSetter: set((_c, v) => ({ weight: asText(v).trim() })),
      editable: true,
      cellEditor: "agTextCellEditor",
      type: "rightAligned",
      // With its own cellClass a column loses the one "rightAligned" adds, so it is listed here too.
      cellClass: ["font-mono", "ag-right-aligned-cell"],
      width: 84,
    },
    {
      colId: "required",
      headerName: "Required",
      headerTooltip: "Required before anything is paid",
      cellDataType: "boolean",
      valueGetter: ({ data }) => data?.required ?? false,
      valueSetter: set((_c, v) => ({ required: v === true })),
      editable: true,
      width: 96,
    },
    { colId: "status", headerName: "", headerTooltip: "Ready, or what is missing", cellRenderer: StatusCell, width: 44 },
    {
      colId: "remove",
      headerName: "",
      cellRenderer: ({ data }: ICellRendererParams<GridCriterion>) =>
        onRemove === null || data === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove criterion ${codes.get(data.key) ?? ""}`}
            title="Remove"
            className="px-2"
            onClick={() => {
              onRemove(data.key);
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        ),
      width: 48,
    },
  ];

  return (
    <div className={ALWAYS_HAS_ROWS}>
    <AgGridReact<GridCriterion>
      theme={settldGridTheme}
      rowData={criteria}
      columnDefs={columns}
      // Headers wrap instead of cutting "Required" to "Requir…" in the form's narrow column.
      defaultColDef={{ resizable: true, sortable: false, wrapHeaderText: true, autoHeaderHeight: true }}
      // The form key: an edit updates the same row, so focus and scroll stay where the buyer is.
      getRowId={({ data }) => String(data.key)}
      domLayout="autoHeight"
      singleClickEdit
      // A click on Save leaves the cell first, which commits the edit to the form before submit.
      stopEditingWhenCellsLoseFocus
      tooltipShowDelay={300}
      onGridReady={({ api }) => {
        registerFlush(() => {
          const editing = api.getEditingCells().length > 0;
          api.stopEditing();
          return editing;
        });
      }}
      onGridPreDestroyed={() => {
        registerFlush(null);
      }}
    />
    </div>
  );
}
