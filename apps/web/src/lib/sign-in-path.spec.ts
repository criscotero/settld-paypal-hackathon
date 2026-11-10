import { describe, expect, it } from "vitest";
import { onboardingEntry, signInPath } from "./sign-in-path";

describe("signInPath", () => {
  it("comes back to the page that was opened", () => {
    expect(signInPath("/contracts/abc")).toBe("/sign-in?redirect_url=%2Fcontracts%2Fabc");
  });
  it("keeps the fragment, which takes the buyer to the milestone", () => {
    expect(signInPath("/contracts/abc#milestone-m1")).toBe("/sign-in?redirect_url=%2Fcontracts%2Fabc%23milestone-m1");
  });
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"])("never returns to %s", (target) => {
    expect(signInPath(target)).toBe("/sign-in");
  });
});

describe("onboardingEntry", () => {
  it("carries a path of this site", () => {
    expect(onboardingEntry("/invitations/abc")).toBe("/onboarding?next=%2Finvitations%2Fabc");
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example"])("drops %s: it would be an open redirect", (next) => {
    expect(onboardingEntry(next)).toBe("/onboarding");
  });

  it("without a destination, plain onboarding", () => {
    expect(onboardingEntry(undefined)).toBe("/onboarding");
  });
});
