import { describe, expect, it } from "vitest";
import { clockText, countdownRows, elapsedShare, newlyEnded, secondsLeft, windowTotals } from "./countdown";
import type { CountdownRow } from "./countdown";
import type { MilestoneRef } from "./dashboard";

const NOW = new Date("2026-11-07T12:00:00Z").getTime();

const ref = (id: string, windowEndsAt: string, amountMinor = 10_000, currency = "USD"): MilestoneRef => ({
  contract: { id: `c-${id}`, title: `Contract ${id}`, myRole: "BUYER", counterpartyName: "Sarah" },
  milestone: { id, contractId: `c-${id}`, title: `Milestone ${id}`, amount: { amountMinor, currency }, dueDate: "2026-11-30", state: "OBJECTION_WINDOW", holdStatus: "AUTHORIZED", stateVersion: 1, nextStep: { actor: "BUYER", kind: "X" }, windowEndsAt },
  myAmount: { amountMinor, currency },
  paid: { amountMinor: 0, currency },
});

describe("countdownRows (ADR-0022, view 4)", () => {
  it("links each row to its milestone and keeps what it is worth to the viewer", () => {
    const [row] = countdownRows([ref("m1", "2026-11-07T12:05:00Z")], new Map([["c-m1", 600]]));
    expect(row).toMatchObject({ id: "m1", href: "/contracts/c-m1#milestone-m1", contract: "Contract m1", milestone: "Milestone m1", paidTo: "Sarah", amount: { amountMinor: 10_000, currency: "USD" }, windowSeconds: 600 });
  });

  it("tells the buyer who is paid: every team member with a hold, or the seller before funding", () => {
    const team = { ...ref("m1", "2026-11-07T12:05:00Z"), milestone: { ...ref("m1", "2026-11-07T12:05:00Z").milestone, holds: [{ payeeUserId: "u1", payeeName: "Sarah", shareBps: 7000, funded: { amountMinor: 0, currency: "USD" }, released: { amountMinor: 0, currency: "USD" }, returned: { amountMinor: 0, currency: "USD" }, holdStatus: "AUTHORIZED" as const }, { payeeUserId: "u2", payeeName: "David", shareBps: 3000, funded: { amountMinor: 0, currency: "USD" }, released: { amountMinor: 0, currency: "USD" }, returned: { amountMinor: 0, currency: "USD" }, holdStatus: "AUTHORIZED" as const }] } };
    expect(countdownRows([team], new Map())[0]?.paidTo).toBe("Sarah, David");
    expect(countdownRows([ref("m2", "2026-11-07T12:05:00Z")], new Map())[0]?.paidTo).toBe("Sarah");
  });

  it("tells a payee the money is theirs", () => {
    const seller = { ...ref("m1", "2026-11-07T12:05:00Z"), contract: { ...ref("m1", "2026-11-07T12:05:00Z").contract, myRole: "SELLER" as const, counterpartyName: "Acme" } };
    expect(countdownRows([seller], new Map())[0]?.paidTo).toBe("You");
  });

  it("has no window length when the contract terms are unknown, instead of guessing one", () => {
    expect(countdownRows([ref("m1", "2026-11-07T12:05:00Z")], new Map())[0]?.windowSeconds).toBeNull();
  });
});

describe("secondsLeft", () => {
  it("counts down to the end and stops at zero", () => {
    const [row] = countdownRows([ref("m1", "2026-11-07T12:01:30Z")], new Map()) as [CountdownRow];
    expect(secondsLeft(row, NOW)).toBe(90);
    expect(secondsLeft(row, NOW + 200_000)).toBe(0);
  });
});

describe("clockText", () => {
  it("reads like the countdown the dashboard already shows", () => {
    expect(clockText(90)).toBe("00:01:30");
    expect(clockText(3 * 86_400 + 5)).toBe("3d 00:00:05");
    // At zero only the server can say the window closed: the page asks it, it does not announce.
    expect(clockText(0)).toBe("Confirming…");
  });
});

describe("elapsedShare", () => {
  it("is how much of the window has passed, between 0 and 1", () => {
    const [row] = countdownRows([ref("m1", "2026-11-07T12:05:00Z")], new Map([["c-m1", 600]])) as [CountdownRow];
    expect(elapsedShare(row, NOW)).toBeCloseTo(0.5);
    expect(elapsedShare(row, NOW + 3_600_000)).toBe(1);
  });

  it("is null without a window length", () => {
    const [row] = countdownRows([ref("m1", "2026-11-07T12:05:00Z")], new Map()) as [CountdownRow];
    expect(elapsedShare(row, NOW)).toBeNull();
  });
});

describe("windowTotals", () => {
  it("splits what is still in a window from what reached zero, per currency", () => {
    const rows = countdownRows([ref("a", "2026-11-07T12:05:00Z", 10_000), ref("b", "2026-11-07T11:59:00Z", 2_500), ref("c", "2026-11-07T13:00:00Z", 700, "EUR")], new Map());
    expect(windowTotals(rows, NOW)).toEqual({
      open: [
        { amountMinor: 700, currency: "EUR" },
        { amountMinor: 10_000, currency: "USD" },
      ],
      releasing: [{ amountMinor: 2_500, currency: "USD" }],
      nextEndsIn: 300,
    });
  });
});

describe("newlyEnded", () => {
  it("flags a window that reached zero after being seen open", () => {
    expect(newlyEnded([{ id: "a", left: 0 }], new Set(["a"])).ended).toEqual(["a"]);
  });

  it("flags a window that arrived after the page opened, once it ends", () => {
    let seen = new Set<string>();
    ({ seenOpen: seen } = newlyEnded([{ id: "late", left: 30 }], seen));
    expect(newlyEnded([{ id: "late", left: 0 }], seen).ended).toEqual(["late"]);
  });

  it("does not flag a window that was already at zero when it arrived, nor flag one twice", () => {
    const first = newlyEnded([{ id: "a", left: 0 }], new Set());
    expect(first.ended).toEqual([]);
    const once = newlyEnded([{ id: "b", left: 0 }], new Set(["b"]));
    expect(newlyEnded([{ id: "b", left: 0 }], once.seenOpen).ended).toEqual([]);
  });
});
