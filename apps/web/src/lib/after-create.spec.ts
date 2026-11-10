import { describe, expect, it } from "vitest";
import { afterCreatePath } from "./after-create";

describe("afterCreatePath", () => {
  it("decide later: just the contract", () => {
    expect(afterCreatePath("c1", { kind: "LATER" })).toBe("/contracts/c1");
  });

  it("invited: the contract with the sent notice", () => {
    expect(afterCreatePath("c1", { kind: "INVITE", email: "a@b.test" })).toBe("/contracts/c1?invited=1");
  });

  it("a failed invitation still lands on the contract, with the code and never the address", () => {
    const path = afterCreatePath("c1", { kind: "INVITE", email: "a@b.test" }, { code: "RATE_LIMITED" });
    expect(path).toBe("/contracts/c1?inviteFailed=RATE_LIMITED");
    expect(path).not.toContain("a@b.test");
  });

  it("publish: the contract, at its publish section", () => {
    expect(afterCreatePath("c1", { kind: "PUBLISH" })).toBe("/contracts/c1?next=publish#publish");
  });
});
