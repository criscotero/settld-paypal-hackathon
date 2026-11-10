import { describe, expect, it } from "vitest";
import { heldTotals, reviewRows, waitingText, waitingTone } from "./review-queue";
import type { EscalatedObjection } from "./review-queue";

const H = 3_600_000;
const NOW = new Date("2026-11-07T12:00:00Z");

const item = (id: string, escalateAt: string, amountMinor = 50_000, currency = "USD"): EscalatedObjection => ({
  objection: { id, milestoneId: "m", runId: "r", criterionIds: [], reason: `reason ${id}`, status: "ESCALATED", raisedAt: "2026-11-01T00:00:00Z", escalateAt },
  contractId: "c",
  contractTitle: `Contract ${id}`,
  milestoneTitle: `Milestone ${id}`,
  amount: { amountMinor, currency },
  buyerName: "Acme",
  sellerName: "Sarah",
});

describe("reviewRows (ADR-0022, view 5)", () => {
  it("measures the wait from when the case escalated", () => {
    const [row] = reviewRows([item("a", "2026-11-07T09:00:00Z")], NOW);
    expect(row?.waitingMs).toBe(3 * H);
    expect(row?.href).toBe("/review/a");
  });

  it("names each case by the start of its id", () => {
    expect(reviewRows([item("3f2a9c1b-0000-7000-8000-000000000000", "2026-11-07T09:00:00Z")], NOW)[0]?.caseRef).toBe("3f2a9c1b");
  });

  it("never shows a negative wait when the clocks disagree", () => {
    expect(reviewRows([item("a", "2026-11-07T12:05:00Z")], NOW)[0]?.waitingMs).toBe(0);
  });

  it("keeps the buyer's reason and both names, as text", () => {
    const [row] = reviewRows([item("<b>x</b>", "2026-11-07T09:00:00Z")], NOW);
    expect(row?.reason).toBe("reason <b>x</b>");
    expect([row?.buyer, row?.seller]).toEqual(["Acme", "Sarah"]);
  });
});

describe("waitingTone", () => {
  it("turns amber after two days and red after three, so the oldest money is seen first", () => {
    expect(waitingTone(47 * H)).toBe("neutral");
    expect(waitingTone(48 * H)).toBe("warn");
    expect(waitingTone(72 * H)).toBe("bad");
  });
});

describe("waitingText", () => {
  it("reads in hours, then days and hours", () => {
    expect(waitingText(20 * 60_000)).toBe("Under 1 h");
    expect(waitingText(5 * H)).toBe("5 h");
    expect(waitingText(53 * H)).toBe("2 d 5 h");
  });
});

describe("heldTotals", () => {
  it("adds per currency, because dollars and euros are not one number", () => {
    const rows = reviewRows([item("a", "2026-11-07T09:00:00Z", 50_000), item("b", "2026-11-07T09:00:00Z", 25_000), item("c", "2026-11-07T09:00:00Z", 10_000, "EUR")], NOW);
    expect(heldTotals(rows)).toEqual([
      { amountMinor: 10_000, currency: "EUR" },
      { amountMinor: 75_000, currency: "USD" },
    ]);
  });
});
