import type { Contract, Milestone } from "./api-types";
import { beforeAgreementText, contractOverview, myStep, sortContracts, turnOfOthers } from "./contract-status";

let n = 0;
const milestone = (state: Milestone["state"], actor: Milestone["nextStep"]["actor"], kind = "X", extra: Partial<Milestone> = {}): Milestone => {
  n += 1;
  return { id: `m${String(n)}`, contractId: "c", title: "M", amount: { amountMinor: 1000, currency: "USD" }, dueDate: "2026-12-01", state, holdStatus: "NONE", stateVersion: 0, nextStep: { actor, kind }, ...extra };
};
const contract = (myRole: Contract["myRole"], milestones: Milestone[], extra: Partial<Contract> = {}): Contract => {
  n += 1;
  return {
    id: `c${String(n)}`,
    title: "C",
    status: "LOCKED",
    myRole,
    counterpartyName: "Other",
    sellerId: "s",
    publishedUntil: null,
    total: { amountMinor: 0, currency: "USD" },
    currentVersion: { id: "v", version: 1, status: "LOCKED", snapshot: {} as never, snapshotHash: "h", approvals: [] },
    milestones,
    ...extra,
  };
};

describe("contractOverview", () => {
  it("does not call a finished contract active", () => {
    expect(contractOverview(contract("BUYER", [milestone("RELEASED", "NONE"), milestone("CLOSED", "NONE")]))).toBe("COMPLETED");
    expect(contractOverview(contract("BUYER", [milestone("VOIDED", "NONE")]))).toBe("CANCELLED");
    expect(contractOverview(contract("BUYER", [milestone("RELEASED", "NONE"), milestone("FUNDED", "SELLER")]))).toBe("ACTIVE");
  });

  it("shows a dispute over everything else", () => {
    expect(contractOverview(contract("BUYER", [milestone("RELEASED", "NONE"), milestone("OBJECTED", "SELLER")]))).toBe("DISPUTE");
  });
});

describe("myStep", () => {
  it("says what is missing, and the deadline", () => {
    expect(myStep(contract("BUYER", [milestone("OBJECTION_WINDOW", "BUYER", "APPROVE_OR_OBJECT", { windowEndsAt: "2026-11-06T10:00:00Z" })]), "me")).toEqual({ label: "Your turn to decide", urgent: true, deadline: "2026-11-06T10:00:00Z" });
    expect(myStep(contract("SELLER", [milestone("IN_PROGRESS", "SELLER", "SUBMIT")]), "me")).toMatchObject({ label: "Your turn to deliver", urgent: false, deadline: "2026-12-01" });
  });

  it("nothing for what waits on someone else", () => {
    expect(myStep(contract("BUYER", [milestone("IN_PROGRESS", "SELLER", "SUBMIT")]), "me")).toBeNull();
  });

  it("asks for the approval, and for the seller a draft lacks", () => {
    const pending = contract("BUYER", [milestone("DRAFT", "NONE")], { status: "PENDING_APPROVAL", currentVersion: { id: "v", version: 1, status: "PENDING_APPROVAL", snapshot: {} as never, snapshotHash: "h", approvals: [] } });
    expect(myStep(pending, "me")?.label).toBe("Your turn to approve the terms");
    const draft = contract("BUYER", [milestone("DRAFT", "NONE")], { status: "DRAFT", sellerId: null, currentVersion: { id: "v", version: 1, status: "DRAFT", snapshot: {} as never, snapshotHash: null, approvals: [] } });
    expect(myStep(draft, "me")?.label).toBe("Your turn to invite the seller");
  });
});

describe("sortContracts", () => {
  const closed = contract("BUYER", [milestone("RELEASED", "NONE")], { lastActivityAt: "2026-11-05T00:00:00Z" });
  const waitingOld = contract("BUYER", [milestone("IN_PROGRESS", "SELLER")], { lastActivityAt: "2026-10-01T00:00:00Z" });
  const waitingNew = contract("BUYER", [milestone("IN_PROGRESS", "SELLER")], { lastActivityAt: "2026-11-01T00:00:00Z" });
  const mineLater = contract("BUYER", [milestone("APPROVED", "BUYER", "FUND", { dueDate: "2026-12-20" })], { lastActivityAt: "2026-11-04T00:00:00Z" });
  const mineSoon = contract("BUYER", [milestone("OBJECTION_WINDOW", "BUYER", "APPROVE_OR_OBJECT", { windowEndsAt: "2026-11-06T00:00:00Z" })], { lastActivityAt: "2026-10-20T00:00:00Z" });

  it("your turn by deadline, then waiting and closed by activity", () => {
    expect(sortContracts([closed, waitingOld, mineLater, waitingNew, mineSoon], "me").map((c) => c.id)).toEqual([mineSoon.id, mineLater.id, waitingNew.id, waitingOld.id, closed.id]);
  });
});

describe("turnOfOthers", () => {
  it("names who the contract waits for", () => {
    expect(turnOfOthers(contract("SELLER", [milestone("APPROVED", "BUYER")]))).toBe("Waiting for the buyer");
    expect(turnOfOthers(contract("BUYER", [milestone("OBJECTED", "REVIEWER")]))).toBe("Waiting for a reviewer");
  });
});

describe("beforeAgreementText", () => {
  const version = (status: Contract["currentVersion"]["status"]) => ({ id: "v", version: 1, status, snapshot: {} as never, snapshotHash: status === "DRAFT" ? null : "h", approvals: [] });

  it("does not say nothing is pending when the step is yours", () => {
    const draft = contract("BUYER", [milestone("DRAFT", "NONE")], { status: "DRAFT", currentVersion: version("DRAFT") });
    expect(beforeAgreementText(draft, "me")).toEqual({ mine: true, text: "Your turn to send for approval" });
  });

  it("says who it waits for when it is not yours", () => {
    const pending = contract("COLLABORATOR", [milestone("DRAFT", "NONE")], { status: "PENDING_APPROVAL", currentVersion: version("PENDING_APPROVAL") });
    expect(beforeAgreementText(pending, "me")).toEqual({ mine: false, text: "Waiting for the other approvals" });
  });
});
