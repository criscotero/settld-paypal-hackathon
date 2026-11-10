import { parseDraftInput } from "./draft-input.js";
import type { DraftInput } from "./draft-input.js";
import { buildSnapshot, hashSnapshot, milestoneGuardFailures, verifiabilityScore } from "./snapshot.js";

const M1 = "0b9e4c1d-8f2a-4e3b-a6c5-d7e8f9a0b1c2";

function draft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    title: "Checkout redesign",
    description: "",
    currency: "USD",
    terms: {
      releaseCountdownSeconds: 172_800,
      silenceIsApproval: true,
      fundingMode: "ONE_AT_A_TIME",
    },
    milestones: [
      {
        title: "Landing page",
        description: "",
        amount: { amountMinor: 50_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: [
          { text: "Page answers 200", level: "AUTOMATIC", required: true, weightBps: 7_000, checkType: "HTTP_PROBE", checkConfig: {} },
          { text: "Looks good", level: "HUMAN", required: true, weightBps: 3_000 },
        ],
      },
    ],
    ...overrides,
  };
}

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

describe("hashSnapshot (RFC 8785)", () => {
  it("does not depend on key order", () => {
    const a = { title: "x", currency: "USD", nested: { b: 1, a: 2 } };
    const b = { nested: { a: 2, b: 1 }, currency: "USD", title: "x" };
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
  });

  it("changes when any value changes", () => {
    expect(hashSnapshot({ amountMinor: 50_000 })).not.toBe(hashSnapshot({ amountMinor: 50_001 }));
  });

  it("has the contract's Sha256 format", () => {
    expect(hashSnapshot({})).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  // RFC 8785 serializes numbers like JavaScript does: 1.0 and 1 are the same number.
  it("treats 1.0 and 1 as the same number", () => {
    expect(hashSnapshot(JSON.parse('{"n":1.0}'))).toBe(hashSnapshot({ n: 1 }));
  });
});

describe("buildSnapshot", () => {
  it("assigns ids to new milestones and criteria, and freezes the platform fee", () => {
    const snap = buildSnapshot(draft(), { platformFeeBps: 0, newId, knownMilestoneIds: new Set(), knownCriterionIds: new Set() });
    expect(snap.terms.platformFeeBps).toBe(0);
    expect(snap.milestones[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(snap.milestones[0]?.criteria[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps ids the caller sends when they already belong to the contract", () => {
    const input = draft();
    const first = input.milestones[0];
    if (first === undefined) throw new Error("fixture");
    const snap = buildSnapshot(
      { ...input, milestones: [{ ...first, id: M1 }] },
      { platformFeeBps: 0, newId, knownMilestoneIds: new Set([M1]), knownCriterionIds: new Set() },
    );
    expect(snap.milestones[0]?.id).toBe(M1);
  });

  // Otherwise a caller could reuse another contract's milestone id.
  it("rejects ids that do not belong to the contract", () => {
    const input = draft();
    const first = input.milestones[0];
    if (first === undefined) throw new Error("fixture");
    expect(() =>
      buildSnapshot(
        { ...input, milestones: [{ ...first, id: M1 }] },
        { platformFeeBps: 0, newId, knownMilestoneIds: new Set(), knownCriterionIds: new Set() },
      ),
    ).toThrow(/milestones\.0\.id/);
  });
});

describe("parseDraftInput", () => {
  it("accepts a valid draft", () => {
    expect(parseDraftInput(draft()).success).toBe(true);
  });

  it("rejects a milestone in another currency (DM-INV-1)", () => {
    const input = draft();
    const first = input.milestones[0];
    if (first === undefined) throw new Error("fixture");
    const result = parseDraftInput({ ...input, milestones: [{ ...first, amount: { amountMinor: 1, currency: "EUR" } }] });
    expect(result.success).toBe(false);
  });

  // Constitution XII and D6: the countdown is never zero, and 60 s is the floor.
  it("rejects a release countdown under 60 seconds", () => {
    const result = parseDraftInput({ ...draft(), terms: { ...draft().terms, releaseCountdownSeconds: 59 } });
    expect(result.success).toBe(false);
  });

  it("requires a weight on every criterion", () => {
    const input = draft();
    const first = input.milestones[0];
    if (first === undefined) throw new Error("fixture");
    const criteria = first.criteria.map((c) => ({ ...c, weightBps: undefined }));
    expect(parseDraftInput({ ...input, milestones: [{ ...first, criteria }] }).success).toBe(false);
  });

  it("requires checkType for AUTOMATIC criteria", () => {
    const input = draft();
    const first = input.milestones[0];
    if (first === undefined) throw new Error("fixture");
    const result = parseDraftInput({
      ...input,
      milestones: [{ ...first, criteria: [{ text: "x", level: "AUTOMATIC", required: true }] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer amount", () => {
    const input = draft();
    const first = input.milestones[0];
    if (first === undefined) throw new Error("fixture");
    const result = parseDraftInput({ ...input, milestones: [{ ...first, amount: { amountMinor: 10.5, currency: "USD" } }] });
    expect(result.success).toBe(false);
  });
});

describe("G-MILESTONE-VALID", () => {
  const today = "2026-10-15";
  const snap = () => buildSnapshot(draft(), { platformFeeBps: 0, newId, knownMilestoneIds: new Set(), knownCriterionIds: new Set() });

  it("passes a valid milestone", () => {
    expect(milestoneGuardFailures(snap(), today)).toEqual([]);
  });

  it("fails when the due date is not in the future", () => {
    const s = snap();
    const failures = milestoneGuardFailures({ ...s, milestones: s.milestones.map((m) => ({ ...m, dueDate: today })) }, today);
    expect(failures).toHaveLength(1);
  });

  it("fails without a required criterion", () => {
    const s = snap();
    const failures = milestoneGuardFailures(
      { ...s, milestones: s.milestones.map((m) => ({ ...m, criteria: m.criteria.map((c) => ({ ...c, required: false })) })) },
      today,
    );
    expect(failures).toHaveLength(1);
  });

  it("fails when the weights do not add up to 100%", () => {
    const s = snap();
    const failures = milestoneGuardFailures(
      { ...s, milestones: s.milestones.map((m) => ({ ...m, criteria: m.criteria.map((c) => ({ ...c, weightBps: 4_000 })) })) },
      today,
    );
    expect(failures).toEqual([{ milestoneId: expect.any(String) as string, reason: "criterion weights must add up to 100% (now 80.00%)" }]);
  });

  it("fails with a zero amount", () => {
    const s = snap();
    const failures = milestoneGuardFailures(
      { ...s, milestones: s.milestones.map((m) => ({ ...m, amount: { ...m.amount, amountMinor: 0 } })) },
      today,
    );
    expect(failures).toHaveLength(1);
  });
});

describe("verifiabilityScore", () => {
  it("is the share of AUTOMATIC and AI_EVALUATED criteria", () => {
    const s = buildSnapshot(draft(), { platformFeeBps: 0, newId, knownMilestoneIds: new Set(), knownCriterionIds: new Set() });
    const milestone = s.milestones[0];
    if (milestone === undefined) throw new Error("fixture");
    expect(verifiabilityScore(milestone)).toBe(0.5);
  });
});
