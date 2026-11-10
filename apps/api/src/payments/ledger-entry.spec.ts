import { describe, expect, it } from "vitest";
import { criteriaPaidBy, ledgerAmountMinor, ledgerEffect, paypalReference } from "./ledger-entry.js";

const fact = (over: Partial<Parameters<typeof ledgerEffect>[0]> = {}) => ({ type: "CAPTURED" as const, releasePartId: null, holdId: "hold", paypal: {}, ...over });

describe("ledgerEffect (ADR-0017)", () => {
  it("counts a capture of a release part as paid", () => {
    expect(ledgerEffect(fact({ releasePartId: "part" }))).toBe("PAID");
  });

  it("does not count the capture made only to refund it, or the total shows money that went back", () => {
    expect(ledgerEffect(fact({ paypal: { return: "true", captureId: "C" } }))).toBe("NONE");
    expect(ledgerEffect(fact({ releasePartId: "part", paypal: { return: "true" } }))).toBe("NONE");
  });

  it("does not count a capture that belongs to no release part", () => {
    expect(ledgerEffect(fact())).toBe("NONE");
  });

  it("counts a refund and a void of a hold as returned", () => {
    expect(ledgerEffect(fact({ type: "REFUNDED" }))).toBe("RETURNED");
    expect(ledgerEffect(fact({ type: "VOIDED" }))).toBe("RETURNED");
  });

  it("does not count voiding an orphan: that money never funded the milestone", () => {
    expect(ledgerEffect(fact({ type: "VOIDED", holdId: null, paypal: { orphan: "true" } }))).toBe("NONE");
    expect(ledgerEffect(fact({ type: "VOIDED", paypal: { orphan: "true" } }))).toBe("NONE");
    expect(ledgerEffect(fact({ type: "AUTHORIZED", paypal: { orphan: "true" } }))).toBe("NONE");
    expect(ledgerEffect(fact({ type: "VOID_REQUESTED", paypal: { orphan: "true" } }))).toBe("NONE");
  });

  it.each(["ORDER_CREATED", "AUTHORIZED", "REAUTHORIZED", "CAPTURE_REQUESTED", "CAPTURE_DENIED", "VOID_REQUESTED", "AUTHORIZATION_EXPIRED", "DISPUTE_OPENED", "DISPUTE_RESOLVED"] as const)("%s moves no money", (type) => {
    expect(ledgerEffect(fact({ type, releasePartId: "part" }))).toBe("NONE");
  });
});

describe("ledgerAmountMinor", () => {
  it("takes the amount of a void from the hold, because the fact has none", () => {
    expect(ledgerAmountMinor({ effect: "RETURNED", type: "VOIDED", amountMinor: null, holdReturnedMinor: 15_000 })).toBe(15_000);
  });

  it("keeps the amount of the fact otherwise", () => {
    expect(ledgerAmountMinor({ effect: "PAID", type: "CAPTURED", amountMinor: 9_000, holdReturnedMinor: 15_000 })).toBe(9_000);
    expect(ledgerAmountMinor({ effect: "RETURNED", type: "REFUNDED", amountMinor: 1_000, holdReturnedMinor: 1_000 })).toBe(1_000);
  });

  it("leaves an orphan's void without an amount rather than inventing one", () => {
    expect(ledgerAmountMinor({ effect: "NONE", type: "VOIDED", amountMinor: null, holdReturnedMinor: null })).toBeNull();
  });
});

describe("paypalReference", () => {
  it("prefers the capture, then the authorization, then the order", () => {
    expect(paypalReference({ orderId: "O", authorizationId: "A", captureId: "C" })).toEqual({ paypalId: "C", paypalIdKind: "CAPTURE" });
    expect(paypalReference({ orderId: "O", authorizationId: "A" })).toEqual({ paypalId: "A", paypalIdKind: "AUTHORIZATION" });
    expect(paypalReference({ orderId: "O" })).toEqual({ paypalId: "O", paypalIdKind: "ORDER" });
  });

  it("treats an empty id as no id: a hold can record an order id it does not have yet", () => {
    expect(paypalReference({ orderId: "", authorizationId: "A" })).toEqual({ paypalId: "A", paypalIdKind: "AUTHORIZATION" });
    expect(paypalReference({})).toEqual({ paypalId: null, paypalIdKind: null });
  });
});

describe("criteriaPaidBy", () => {
  const release = (seq: number, status: "PENDING" | "CAPTURED" | "FAILED", countedCriterionIds: string[]) => ({ seq, status, countedCriterionIds });

  it("subtracts what earlier releases paid, because countedCriterionIds is cumulative", () => {
    const first = release(1, "CAPTURED", ["a", "b"]);
    const second = release(2, "CAPTURED", ["a", "b", "c"]);
    expect(criteriaPaidBy(first, [first, second])).toEqual(["a", "b"]);
    expect(criteriaPaidBy(second, [first, second])).toEqual(["c"]);
  });

  it("does not subtract a release PayPal declined: its criteria were not paid", () => {
    const declined = release(1, "FAILED", ["a"]);
    const retry = release(2, "CAPTURED", ["a", "b"]);
    expect(criteriaPaidBy(retry, [declined, retry])).toEqual(["a", "b"]);
  });

  it("does not subtract later releases", () => {
    const first = release(1, "CAPTURED", ["a"]);
    const second = release(2, "PENDING", ["a", "b"]);
    expect(criteriaPaidBy(first, [second, first])).toEqual(["a"]);
  });
});
