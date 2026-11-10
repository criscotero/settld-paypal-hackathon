import { describe, expect, it } from "vitest";
import { donePath, isPaypalOutcome, sellerOutcome } from "./paypal-return";

describe("sellerOutcome", () => {
  it("409 means PayPal has not confirmed the merchant yet", () => {
    expect(sellerOutcome(409, undefined)).toBe("seller-pending");
  });
  it("any other failure is a failed link", () => {
    expect(sellerOutcome(502, undefined)).toBe("link-failed");
  });
  it("a finished onboarding wins over the PayPal flags", () => {
    expect(sellerOutcome(200, { onboarding: { completed: true }, paypalReady: false })).toBe("done");
  });
  it("connected but not finished says whether PayPal can pay the account", () => {
    expect(sellerOutcome(200, { onboarding: { completed: false }, paypalReady: true })).toBe("seller-connected");
    expect(sellerOutcome(200, { onboarding: { completed: false }, paypalReady: false })).toBe("seller-limited");
  });
});

describe("isPaypalOutcome", () => {
  it("accepts only the known outcomes", () => {
    expect(isPaypalOutcome("seller-connected")).toBe(true);
    expect(isPaypalOutcome("<script>")).toBe(false);
    expect(isPaypalOutcome(null)).toBe(false);
  });
});

it("donePath carries the outcome", () => {
  expect(donePath("linked")).toBe("/onboarding/paypal/done?paypal=linked");
});
