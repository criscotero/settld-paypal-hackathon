import { contractSteps, milestoneHistory } from "./progress";

type State = Parameters<typeof milestoneHistory>[0];
const m = (id: string, state: State) => ({ id, title: id, state });

describe("contractSteps", () => {
  it("puts the agreement first and makes it current until the contract is locked", () => {
    const steps = contractSteps("PENDING_APPROVAL", [m("a", "DRAFT"), m("b", "DRAFT")]);
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ["agreement", "current"],
      ["a", "upcoming"],
      ["b", "upcoming"],
    ]);
  });

  it("makes the first unfinished milestone current once agreed", () => {
    const steps = contractSteps("LOCKED", [m("a", "RELEASED"), m("b", "IN_PROGRESS"), m("c", "APPROVED")]);
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "current", "upcoming"]);
  });

  it("marks an objection as a problem on the current step", () => {
    const steps = contractSteps("LOCKED", [m("a", "OBJECTED"), m("b", "APPROVED")]);
    expect(steps.map((s) => s.status)).toEqual(["done", "problem", "upcoming"]);
  });

  it("skips voided milestones when choosing the current one", () => {
    const steps = contractSteps("LOCKED", [m("a", "VOIDED"), m("b", "APPROVED")]);
    expect(steps.map((s) => s.status)).toEqual(["done", "cancelled", "current"]);
  });

  it("has no current step when everything is finished", () => {
    const steps = contractSteps("LOCKED", [m("a", "RELEASED"), m("b", "VOIDED")]);
    expect(steps.some((s) => s.status === "current")).toBe(false);
  });
});

describe("milestoneHistory", () => {
  it("is all upcoming while the milestone is a draft", () => {
    expect(milestoneHistory("DRAFT").every((e) => e.status === "upcoming")).toBe(true);
  });

  it("marks everything before the state as done and the state as current", () => {
    expect(milestoneHistory("VERIFYING").map((e) => [e.state, e.status])).toEqual([
      ["APPROVED", "done"],
      ["FUNDED", "done"],
      ["IN_PROGRESS", "done"],
      ["VERIFYING", "current"],
      ["OBJECTION_WINDOW", "upcoming"],
      ["RELEASED", "upcoming"],
    ]);
  });

  it("shows RELEASED as done, not current: nothing happens after it", () => {
    expect(milestoneHistory("RELEASED").every((e) => e.status === "done")).toBe(true);
  });

  it("inserts the objection after the window it was raised in (SM-T10)", () => {
    const h = milestoneHistory("OBJECTED");
    expect(h.map((e) => [e.state, e.status])).toEqual([
      ["APPROVED", "done"],
      ["FUNDED", "done"],
      ["IN_PROGRESS", "done"],
      ["VERIFYING", "done"],
      ["OBJECTION_WINDOW", "done"],
      ["OBJECTED", "problem"],
      ["RELEASED", "upcoming"],
    ]);
  });

  it("does not invent where a voided milestone stopped", () => {
    // VOIDED is reachable from DRAFT, APPROVED, FUNDED, IN_PROGRESS and OBJECTED
    // (SM-T14..T16); the state alone does not say which.
    expect(milestoneHistory("VOIDED").map((e) => [e.state, e.status])).toEqual([["VOIDED", "cancelled"]]);
  });

  it("shows a partial release as current, with the full release still ahead (ADR-0007)", () => {
    const h = milestoneHistory("PARTIALLY_RELEASED").map((e) => [e.state, e.status]);
    expect(h.slice(-2)).toEqual([
      ["PARTIALLY_RELEASED", "current"],
      ["RELEASED", "upcoming"],
    ]);
    expect(milestoneHistory("CLOSED").at(-1)).toEqual({ state: "CLOSED", status: "done" });
  });
});
