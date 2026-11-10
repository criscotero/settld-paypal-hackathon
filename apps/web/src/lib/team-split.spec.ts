import { describe, expect, it } from "vitest";
import type { Contract, Milestone } from "./api-types";
import { teamSplit } from "./team-split";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
type Hold = NonNullable<Milestone["holds"]>[number];
type Member = NonNullable<Contract["team"]>[number];

const member = (userId: string | null, name: string, shareBps: number | null, isSeller = false): Member => ({ userId, displayName: name, role: isSeller ? "Lead" : "Designer", shareBps, isSeller, approvedCurrentVersion: true, professions: [], headline: null });
const hold = (payeeUserId: string, payeeName: string, shareBps: number, funded: number, released = 0): Hold => ({ payeeUserId, payeeName, shareBps, funded: usd(funded), released: usd(released), returned: usd(0), holdStatus: funded > 0 ? "AUTHORIZED" : "NONE" });
const milestone = (id: string, amount: number, over: Partial<Milestone> = {}): Milestone => ({ id, contractId: "c", title: `Milestone ${id}`, amount: usd(amount), dueDate: "2026-12-01", state: "APPROVED", holdStatus: "NONE", stateVersion: 1, nextStep: { actor: "BUYER", kind: "X" }, ...over });
const release = (parts: { payeeUserId: string; amount: number }[]) => ({ id: "r", seq: 1, transitionId: "SM-T18", amount: usd(parts.reduce((s, p) => s + p.amount, 0)), platformFee: usd(0), countedBps: 10_000, final: true, status: "CAPTURED" as const, decidedAt: "2026-11-05T00:00:00Z", parts: parts.map((p) => ({ payeeUserId: p.payeeUserId, amount: usd(p.amount), platformFee: usd(0), status: "CAPTURED" as const })) });

const team = [member("seller", "Sarah", 7000, true), member("ana", "Ana", 3000)];

describe("teamSplit (ADR-0024)", () => {
  it("gives one row per member and one column per milestone, coded M1, M2", () => {
    const s = teamSplit({ myRole: "BUYER", team, milestones: [milestone("a", 1000), milestone("b", 2000)] }, "buyer");
    expect(s.columns.map((c) => c.code)).toEqual(["M1", "M2"]);
    expect(s.rows.map((r) => [r.name, r.cells.a?.amountMinor, r.cells.b?.amountMinor, r.totalMinor])).toEqual([
      ["Sarah", 700, 1400, 2100],
      ["Ana", 300, 600, 900],
    ]);
  });

  it("plans with Core's rule: the leftover cents go to the seller, so nothing is lost or invented", () => {
    const s = teamSplit({ myRole: "SELLER", team, milestones: [milestone("a", 1001)] }, "seller");
    expect(s.rows.map((r) => r.cells.a?.amountMinor)).toEqual([701, 300]);
    expect(s.sums).toEqual({ a: 1001 });
    expect(s.mismatched).toEqual([]);
  });

  it("uses the hold for a funded milestone, and says how much PayPal already paid", () => {
    const m = milestone("a", 1000, { state: "RELEASED", holds: [hold("seller", "Sarah", 7000, 700, 700), hold("ana", "Ana", 3000, 300, 300)], releases: [release([{ payeeUserId: "seller", amount: 700 }, { payeeUserId: "ana", amount: 300 }])] });
    const s = teamSplit({ myRole: "BUYER", team, milestones: [m] }, "buyer");
    expect(s.rows.map((r) => r.cells.a)).toEqual([
      { amountMinor: 700, paidMinor: 700, planned: false },
      { amountMinor: 300, paidMinor: 300, planned: false },
    ]);
  });

  it("marks a milestone that is not funded yet as planned", () => {
    const s = teamSplit({ myRole: "BUYER", team, milestones: [milestone("a", 1000)] }, "buyer");
    expect(s.rows.every((r) => r.cells.a?.planned === true)).toBe(true);
  });

  it("gives a collaborator only their own row, and never the others' parts", () => {
    const seen = [member("seller", "Sarah", null, true), member("ana", "Ana", 3000)];
    const s = teamSplit({ myRole: "COLLABORATOR", team: seen, milestones: [milestone("a", 1001)] }, "ana");
    expect(s.ownOnly).toBe(true);
    expect(s.rows.map((r) => [r.name, r.cells.a?.amountMinor])).toEqual([["Ana", 300]]);
    expect(s.sums).toBeNull();
  });

  it("does not hand a collaborator the leftover cents when only their own hold arrives", () => {
    const m = milestone("a", 1001, { holds: [hold("ana", "Ana", 3000, 0)] });
    const s = teamSplit({ myRole: "COLLABORATOR", team: [member("seller", "Sarah", null, true), member("ana", "Ana", 3000)], milestones: [m] }, "ana");
    expect(s.rows[0]?.cells.a).toEqual({ amountMinor: 300, paidMinor: 0, planned: true });
  });

  it("follows the milestone's holds when the team changed after funding, keeping a member who left", () => {
    const m = milestone("a", 1000, { holds: [hold("seller", "Sarah", 5000, 500), hold("leo", "Leo", 5000, 500)] });
    const s = teamSplit({ myRole: "SELLER", team, milestones: [m] }, "seller");
    expect(s.rows.map((r) => [r.name, r.cells.a?.amountMinor ?? null])).toEqual([
      ["Sarah", 500],
      ["Ana", null],
      ["Leo", 500],
    ]);
  });

  it("flags a milestone whose rows do not add up, instead of adjusting a number", () => {
    const m = milestone("a", 1000, { holds: [hold("seller", "Sarah", 7000, 690), hold("ana", "Ana", 3000, 300)] });
    expect(teamSplit({ myRole: "BUYER", team, milestones: [m] }, "buyer").mismatched).toEqual(["a"]);
  });

  it("keeps the seller's slot as a row before a seller accepts", () => {
    const s = teamSplit({ myRole: "BUYER", team: [member(null, "Seller", 10_000, true)], milestones: [milestone("a", 1000)] }, "buyer");
    expect(s.rows.map((r) => [r.id, r.cells.a?.amountMinor])).toEqual([["seller", 1000]]);
  });
});
