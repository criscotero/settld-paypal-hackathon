// The payments ledger as the screen reads it (ADR-0017). Pure, so it can be tested without a grid.
// Nothing here knows which event types are money: Core API decides that in `ledgerEffect`.
import type { Schemas } from "./api-types";

type Entry = Schemas["LedgerEntry"];

export const LEDGER_VIEWS = [
  { id: "money", label: "All money" },
  { id: "captures", label: "Captures" },
  { id: "returns", label: "Returns" },
  { id: "full", label: "Full ledger" },
] as const;
export type LedgerView = (typeof LEDGER_VIEWS)[number]["id"];

export function entriesInView(entries: readonly Entry[], view: LedgerView): Entry[] {
  switch (view) {
    case "money":
      return entries.filter((e) => e.ledgerEffect !== "NONE");
    case "captures":
      return entries.filter((e) => e.ledgerEffect === "PAID");
    case "returns":
      return entries.filter((e) => e.ledgerEffect === "RETURNED");
    case "full":
      return [...entries];
  }
}

export interface CurrencyTotal {
  readonly currency: string;
  readonly paidMinor: number;
  readonly returnedMinor: number;
}

// One total per currency. A single figure over two currencies would be a number that means nothing,
// and it would look exactly like one that does.
export function totalsByCurrency(entries: readonly Entry[]): CurrencyTotal[] {
  const totals = new Map<string, { paidMinor: number; returnedMinor: number }>();
  for (const e of entries) {
    if (e.ledgerEffect === "NONE" || e.amount === null) continue;
    const t = totals.get(e.amount.currency) ?? { paidMinor: 0, returnedMinor: 0 };
    if (e.ledgerEffect === "PAID") t.paidMinor += e.amount.amountMinor;
    else t.returnedMinor += e.amount.amountMinor;
    totals.set(e.amount.currency, t);
  }
  return [...totals].map(([currency, t]) => ({ currency, ...t })).sort((a, b) => a.currency.localeCompare(b.currency));
}

// A cell starting with one of these runs as a formula when the file opens in a spreadsheet, and
// contract titles and names are typed by other people. The apostrophe makes it plain text.
export function csvText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export const CSV_COLUMNS = ["date", "contract", "milestone", "counterparty", "event", "amount_minor", "currency", "platform_fee_minor", "paypal_id"] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

// The columns of exportPayments in openapi.yaml, so the file matches the endpoint when it exists.
// Amounts stay as digits: csvText only guards text other people typed.
export function csvCells(e: Entry): Record<CsvColumn, string> {
  return {
    date: e.occurredAt,
    contract: csvText(e.contractTitle),
    milestone: csvText(e.milestoneTitle),
    counterparty: csvText(e.counterpartyName ?? ""),
    event: e.type,
    amount_minor: e.amount === null ? "" : String(e.amount.amountMinor),
    currency: e.amount?.currency ?? e.platformFee?.currency ?? "",
    platform_fee_minor: e.platformFee === null ? "" : String(e.platformFee.amountMinor),
    paypal_id: e.paypalId ?? "",
  };
}

// null means this is the first load: every row would be "new", and the whole table would flash.
export function newIds(seen: ReadonlySet<string> | null, entries: readonly Entry[]): string[] {
  if (seen === null) return [];
  return entries.filter((e) => !seen.has(e.id)).map((e) => e.id);
}

// The same bounds as Core API, which refuses anything else: Postgres has no year 0, and the day after
// 9999-12-31 has no four-digit year.
const MIN_DAY = "1000-01-01";
const MAX_DAY = "9998-12-31";

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Date rolls 2026-02-31 into March, so a date is real only if it comes back unchanged.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= MIN_DAY && value <= MAX_DAY;
}

// The range lives in the URL, like the directory's filters: it can be shared or reopened, and a
// stale or edited link still opens the page instead of an error.
export function parseLedgerRange(query: Record<string, string | string[] | undefined>, today: string): { from: string; to: string } {
  const { from, to } = query;
  if (validDate(from) && validDate(to) && from <= to) return { from, to };
  const lastYear = new Date(`${today}T00:00:00.000Z`);
  lastYear.setUTCFullYear(lastYear.getUTCFullYear() - 1);
  return { from: lastYear.toISOString().slice(0, 10), to: today };
}

// AG Grid hands the date filter's box as local midnight and the cell as a full timestamp, so without
// this "equals Nov 6" matches nothing. The column is shown in UTC, so the cell's UTC day is compared
// with the local day the person picked. Negative: the cell is before the filter (AG Grid's contract).
export function compareUtcDay(filterLocalMidnight: Date, cell: Date | null): number {
  if (cell === null) return -1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const picked = `${String(filterLocalMidnight.getFullYear())}-${pad(filterLocalMidnight.getMonth() + 1)}-${pad(filterLocalMidnight.getDate())}`;
  const day = cell.toISOString().slice(0, 10);
  return day < picked ? -1 : day > picked ? 1 : 0;
}
