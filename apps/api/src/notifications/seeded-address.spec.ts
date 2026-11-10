import { describe, expect, it } from "vitest";
import { isSeededAddress } from "./seeded-address.js";

describe("isSeededAddress", () => {
  it("catches the seed scripts' domains, their subdomains and any case", () => {
    expect(isSeededAddress("admin@dev.settld.app")).toBe(true);
    expect(isSeededAddress("lucia.romero@demo.settld.app")).toBe(true);
    expect(isSeededAddress("maya@northwindlabs.demo.settld.app")).toBe(true);
    expect(isSeededAddress("Admin@DEV.Settld.App")).toBe(true);
  });

  it("lets real addresses through, including ones that only look alike", () => {
    expect(isSeededAddress("altamiratechlabs+clerk_test_buyer_1@gmail.com")).toBe(false);
    expect(isSeededAddress("someone@settld.app")).toBe(false);
    expect(isSeededAddress("x@notdev.settld.app")).toBe(false);
    expect(isSeededAddress("x@dev.settld.app.example.com")).toBe(false);
    // The e2e tests' users: their mail goes to a fake sender, and the tests need it sent.
    expect(isSeededAddress("u@test.settld.app")).toBe(false);
  });
});
