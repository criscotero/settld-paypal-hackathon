import { holdText, moneyText, nextStepText, returnNotice } from "./copy";

describe("nextStepText", () => {
  it("speaks to the viewer when the next step is theirs", () => {
    expect(nextStepText({ actor: "BUYER", kind: "FUND" }, "BUYER")).toEqual({ mine: true, text: "You: fund this milestone" });
  });

  it("names who we are waiting for otherwise", () => {
    expect(nextStepText({ actor: "BUYER", kind: "FUND" }, "SELLER")).toEqual({ mine: false, text: "Waiting for the buyer: fund this milestone" });
    expect(nextStepText({ actor: "SYSTEM", kind: "WAIT_FOR_VERIFICATION" }, "BUYER")).toEqual({ mine: false, text: "Settld: verify the delivery" });
  });

  it("has a sentence for NONE and for kinds added to the contract later", () => {
    expect(nextStepText({ actor: "NONE", kind: "APPROVE_CONTRACT_VERSION" }, "BUYER").text).toBe("Nothing to do right now");
    expect(nextStepText({ actor: "BUYER", kind: "SOMETHING_NEW" }, "BUYER").text).toBe("You: something new");
  });
});

describe("holdText", () => {
  it("never says Settld holds the money (constitution I)", () => {
    for (const s of ["NONE", "ORDER_CREATED", "AUTHORIZED", "CAPTURE_PENDING", "CAPTURED", "CAPTURE_FAILED", "VOID_PENDING", "VOIDED", "EXPIRED"] as const) {
      expect(holdText(s)).not.toMatch(/settld (holds|has)/i);
    }
  });
});

describe("moneyText", () => {
  const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
  type M = Parameters<typeof moneyText>[0];
  const text = (state: M["state"], holdStatus: M["holdStatus"], released = 0, team = false) => moneyText({ state, holdStatus, released: usd(released) }, team);

  it("never says 'not charged' about a milestone already paid in part", () => {
    expect(text("PARTIALLY_RELEASED", "AUTHORIZED", 450)).toMatch(/^Part was paid to the seller/);
    expect(text("IN_PROGRESS", "AUTHORIZED")).toMatch(/not charged yet/);
  });

  it("never says 'nothing was charged' about a closed milestone that paid something", () => {
    expect(text("CLOSED", "VOIDED", 450)).toMatch(/^Part was paid/);
    expect(text("VOIDED", "VOIDED")).toMatch(/nothing was charged/);
  });

  it("does not promise a retry that never happens (CAPTURE_FAILED)", () => {
    expect(text("RELEASED", "CAPTURE_FAILED", 1000)).toMatch(/not retried/);
  });

  it("asks to fund again only where funding is possible", () => {
    expect(text("APPROVED", "EXPIRED")).toMatch(/fund again/);
    expect(text("OBJECTED", "EXPIRED")).toMatch(/review/);
  });

  it("names the team when there is one", () => {
    expect(text("RELEASED", "CAPTURED", 1000, true)).toBe("Paid to the team.");
  });
});

describe("nextStepText with a reviewer", () => {
  it("says who decides an escalated objection", () => {
    expect(nextStepText({ actor: "REVIEWER", kind: "RULE_ON_OBJECTION" }, "SELLER")).toEqual({ mine: false, text: "Waiting for a reviewer: decide the objection" });
  });
});

describe("returnNotice", () => {
  const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
  const m = { returnReason: "WINDOW_EXPIRED" as const, held: usd(1000), released: usd(0), amount: usd(1000) };

  it("says what happened, where the money is and who acts", () => {
    expect(returnNotice(m, "BUYER")).toEqual({ title: "The countdown ended without a decision", text: "The buyer did not decide in time. Nothing was paid, and $10.00 stays reserved. Now the seller has to deliver again." });
    expect(returnNotice(m, "SELLER")?.text).toContain("your turn to deliver again");
  });

  it("does not say nothing was paid when something was", () => {
    expect(returnNotice({ ...m, released: usd(400), held: usd(600) }, "SELLER")?.text).toContain("What was already paid stands, and $6.00 stays reserved");
  });

  it("is silent when no round was sent back", () => {
    expect(returnNotice({ ...m, returnReason: null }, "SELLER")).toBeNull();
  });
});
