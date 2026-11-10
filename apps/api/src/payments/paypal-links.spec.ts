import { describe, expect, it } from "vitest";
import { paypalUrl } from "./paypal-links.js";

const SANDBOX = "https://www.sandbox.paypal.com";
const base = { webBase: SANDBOX, paypalId: "6FH412157X1177138", paypalIdKind: "CAPTURE" as const, occurredAt: new Date("2026-11-05T16:51:49Z"), now: new Date("2026-11-07T14:00:00Z") };

describe("paypalUrl", () => {
  it("sends the payee of the hold to the capture itself, which is their transaction", () => {
    expect(paypalUrl({ ...base, viewer: "PAYEE" })).toBe(`${SANDBOX}/activity/payment/6FH412157X1177138`);
  });

  it("sends the buyer to their activity searched by Settld's id, because their transaction has another id", () => {
    expect(paypalUrl({ ...base, viewer: "PAYER" })).toBe(`${SANDBOX}/myaccount/activities/?free_text_search=6FH412157X1177138&start_date=2026-11-04&end_date=2026-11-07`);
  });

  it("starts the search a day early, so a payment near midnight in the buyer's time zone is still in range", () => {
    const url = new URL(paypalUrl({ ...base, viewer: "PAYER", occurredAt: new Date("2026-11-05T00:30:00Z") }) ?? "");
    expect(url.searchParams.get("start_date")).toBe("2026-11-04");
  });

  it("ends the search today, because PayPal ignores a range that ends in the future and falls back to 90 days", () => {
    const url = new URL(paypalUrl({ ...base, viewer: "PAYER", occurredAt: new Date("2026-05-01T10:00:00Z") }) ?? "");
    expect(url.searchParams.get("end_date")).toBe("2026-11-07");
    expect(url.searchParams.get("start_date")).toBe("2026-04-30");
  });

  it("finds an authorization in the buyer's activity too", () => {
    expect(paypalUrl({ ...base, viewer: "PAYER", paypalId: "1H5964906G765764W", paypalIdKind: "AUTHORIZATION" })).toContain("free_text_search=1H5964906G765764W");
  });

  it("gives no link for an order id, which the buyer's search does not find", () => {
    expect(paypalUrl({ ...base, viewer: "PAYER", paypalId: "26U79453RS782104J", paypalIdKind: "ORDER" })).toBeNull();
  });

  it("gives the payee no link for an authorization, until a merchant account shows it works", () => {
    expect(paypalUrl({ ...base, viewer: "PAYEE", paypalIdKind: "AUTHORIZATION" })).toBeNull();
  });

  it("gives no link to someone with no record of the fact in PayPal, like a seller looking at a collaborator's capture", () => {
    expect(paypalUrl({ ...base, viewer: "NONE" })).toBeNull();
  });

  it("gives no link for a fact with no PayPal id", () => {
    expect(paypalUrl({ ...base, viewer: "PAYER", paypalId: null, paypalIdKind: null })).toBeNull();
  });

  it("gives no link without a PayPal environment, so the fake provider's ids never point at real PayPal", () => {
    expect(paypalUrl({ ...base, viewer: "PAYER", webBase: null })).toBeNull();
  });

  it("escapes the id, so a stored value can never add parameters to the link", () => {
    expect(paypalUrl({ ...base, viewer: "PAYER", paypalId: "A&end_date=1999-01-01" })).toContain("free_text_search=A%26end_date%3D1999-01-01&");
    expect(paypalUrl({ ...base, viewer: "PAYEE", paypalId: "../x" })).toBe(`${SANDBOX}/activity/payment/..%2Fx`);
  });
});
