import { nextStep } from "./contract-view.js";

const none = new Set<string>();

describe("nextStep", () => {
  it("names the actor of the transition that leaves each state (milestone-state-machine.md)", () => {
    const at = (state: Parameters<typeof nextStep>[0]["state"]) => nextStep({ state }, { status: "LOCKED" }, none);
    expect(at("APPROVED")).toEqual({ actor: "BUYER", kind: "FUND", at: null });
    expect(at("FUNDED")).toEqual({ actor: "SELLER", kind: "START_WORK", at: null });
    expect(at("IN_PROGRESS")).toEqual({ actor: "SELLER", kind: "SUBMIT", at: null });
    expect(at("VERIFYING")).toEqual({ actor: "SYSTEM", kind: "WAIT_FOR_VERIFICATION", at: null });
    expect(at("OBJECTION_WINDOW")).toEqual({ actor: "BUYER", kind: "APPROVE_OR_OBJECT", at: null });
    expect(at("OBJECTED")).toEqual({ actor: "SELLER", kind: "RESPOND_TO_OBJECTION", at: null });
  });

  it("has nobody to wait for once a milestone is released or voided", () => {
    expect(nextStep({ state: "RELEASED" }, { status: "LOCKED" }, none).actor).toBe("NONE");
    expect(nextStep({ state: "VOIDED" }, { status: "LOCKED" }, none).actor).toBe("NONE");
  });

  it("waits for the party that has not approved a pending version", () => {
    expect(nextStep({ state: "DRAFT" }, { status: "PENDING_APPROVAL" }, new Set(["BUYER"]))).toEqual({ actor: "SELLER", kind: "APPROVE_CONTRACT_VERSION", at: null });
    expect(nextStep({ state: "DRAFT" }, { status: "PENDING_APPROVAL" }, none).actor).toBe("NONE");
  });
});
