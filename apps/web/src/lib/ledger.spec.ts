import { describe, expect, it } from "vitest";
import type { Schemas } from "./api-types";
import { compareUtcDay, csvCells, csvText, entriesInView, newIds, parseLedgerRange, totalsByCurrency } from "./ledger";

type Entry = Schemas["LedgerEntry"];

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: "e1",
  type: "CAPTURED",
  occurredAt: "2026-11-06T15:00:00.000Z",
  source: "API_RESPONSE",
  milestoneId: "m1",
  milestoneTitle: "Checkout",
  contractId: "c1",
  contractTitle: "Store",
  myRole: "BUYER",
  counterpartyName: "Sarah",
  amount: { amountMinor: 1_000, currency: "USD" },
  platformFee: { amountMinor: 50, currency: "USD" },
  ledgerEffect: "PAID",
  paypalId: "CAP1",
  paypalIdKind: "CAPTURE",
  paypalUrl: null,
  releaseId: "r1",
  criteria: [],
  reportHash: null,
  ...over,
});

describe("totalsByCurrency", () => {
  it("adds only what the server marked, whatever the event type says", () => {
    const rows = [entry(), entry({ id: "e2", type: "CAPTURED", ledgerEffect: "NONE", amount: { amountMinor: 500, currency: "USD" } }), entry({ id: "e3", type: "REFUNDED", ledgerEffect: "RETURNED", amount: { amountMinor: 200, currency: "USD" } })];
    expect(totalsByCurrency(rows)).toEqual([{ currency: "USD", paidMinor: 1_000, returnedMinor: 200 }]);
  });

  it("never adds two currencies together", () => {
    const rows = [entry(), entry({ id: "e2", amount: { amountMinor: 700, currency: "EUR" } })];
    expect(totalsByCurrency(rows)).toEqual([
      { currency: "EUR", paidMinor: 700, returnedMinor: 0 },
      { currency: "USD", paidMinor: 1_000, returnedMinor: 0 },
    ]);
  });

  it("leaves out rows with no effect, so a view of them shows no zero total", () => {
    expect(totalsByCurrency([entry({ ledgerEffect: "NONE" })])).toEqual([]);
  });
});

describe("entriesInView", () => {
  const rows = [entry({ id: "paid" }), entry({ id: "returned", ledgerEffect: "RETURNED", type: "REFUNDED" }), entry({ id: "none", ledgerEffect: "NONE", type: "AUTHORIZED" })];
  const ids = (view: Parameters<typeof entriesInView>[1]) => entriesInView(rows, view).map((e) => e.id);

  it("opens on the money only, and the full ledger shows everything", () => {
    expect(ids("money")).toEqual(["paid", "returned"]);
    expect(ids("captures")).toEqual(["paid"]);
    expect(ids("returns")).toEqual(["returned"]);
    expect(ids("full")).toEqual(["paid", "returned", "none"]);
  });
});

describe("csvText", () => {
  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"])("defuses %j so a spreadsheet does not run it as a formula", (value) => {
    expect(csvText(value)).toBe(`'${value}`);
  });

  it("leaves ordinary text alone", () => {
    expect(csvText("Bennett Home Goods")).toBe("Bennett Home Goods");
  });
});

describe("csvCells", () => {
  it("has the columns of the contract, with money in minor units", () => {
    expect(csvCells(entry())).toEqual({ date: "2026-11-06T15:00:00.000Z", contract: "Store", milestone: "Checkout", counterparty: "Sarah", event: "CAPTURED", amount_minor: "1000", currency: "USD", platform_fee_minor: "50", paypal_id: "CAP1" });
  });

  it("guards the text other people typed and leaves amounts as digits", () => {
    expect(csvCells(entry({ contractTitle: "=HYPERLINK(1)", counterpartyName: "@me" }))).toMatchObject({ contract: "'=HYPERLINK(1)", counterparty: "'@me", amount_minor: "1000" });
  });

  it("writes empty cells for what a fact does not have", () => {
    expect(csvCells(entry({ amount: null, platformFee: null, paypalId: null, counterpartyName: null }))).toMatchObject({ amount_minor: "", currency: "", platform_fee_minor: "", paypal_id: "", counterparty: "" });
  });
});

describe("newIds", () => {
  it("names what appeared since the last refresh", () => {
    expect(newIds(new Set(["a"]), [entry({ id: "a" }), entry({ id: "b" })])).toEqual(["b"]);
  });

  it("flashes nothing on the first load, when everything would count as new", () => {
    expect(newIds(null, [entry({ id: "a" })])).toEqual([]);
  });
});

describe("parseLedgerRange", () => {
  const today = "2026-11-06";

  it("defaults to the last year", () => {
    expect(parseLedgerRange({}, today)).toEqual({ from: "2025-11-06", to: "2026-11-06" });
  });

  it("keeps a valid range from the URL", () => {
    expect(parseLedgerRange({ from: "2026-01-01", to: "2026-03-31" }, today)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it.each([{ from: "nope", to: "2026-03-31" }, { from: "2026-02-31", to: "2026-03-31" }, { from: "2026-04-01", to: "2026-03-31" }, { from: ["2026-01-01", "2026-01-02"], to: "2026-03-31" }, { from: "0000-01-01", to: "2026-03-31" }, { from: "2026-01-01", to: "9999-12-31" }])("falls back when the URL says %j, so an edited link still opens the page", (query) => {
    expect(parseLedgerRange(query, today)).toEqual({ from: "2025-11-06", to: "2026-11-06" });
  });
});

describe("compareUtcDay", () => {
  // Built from local parts, as AG Grid builds the date typed in the filter.
  const picked = new Date(2026, 10, 6);

  it("matches any time of the picked day, in UTC as the column shows it", () => {
    expect(compareUtcDay(picked, new Date("2026-11-06T00:00:00.000Z"))).toBe(0);
    expect(compareUtcDay(picked, new Date("2026-11-06T23:59:59.000Z"))).toBe(0);
  });

  it("orders the days around it", () => {
    expect(compareUtcDay(picked, new Date("2026-11-05T23:59:59.000Z"))).toBe(-1);
    expect(compareUtcDay(picked, new Date("2026-11-07T00:00:00.000Z"))).toBe(1);
    expect(compareUtcDay(picked, null)).toBe(-1);
  });
});
