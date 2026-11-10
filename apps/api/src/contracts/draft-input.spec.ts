import { parseDraftInput } from "./draft-input.js";

const CONFIG = { sources: ["HTTP_RESPONSE", "NOTES"], guidance: "The page lists all three plans" };

function draft(criterion: Record<string, unknown>) {
  return {
    title: "Landing",
    currency: "USD",
    terms: {},
    milestones: [
      {
        title: "Page",
        amount: { amountMinor: 1_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: [{ text: "Plans are listed", level: "AI_EVALUATED", weightBps: 10_000, checkType: "AI_REQUIREMENT_MET", checkConfig: CONFIG, ...criterion }],
      },
    ],
  };
}

const accepts = (criterion: Record<string, unknown>) => parseDraftInput(draft(criterion)).success;

// ai-check.v1.json. Checked when saving, because what both parties approve is this config: a bad
// one would only surface after the money is reserved, as a check that can never run.
describe("the config of an AI criterion", () => {
  it("accepts the contract's shape", () => {
    expect(accepts({})).toBe(true);
    expect(accepts({ checkType: "AI_FEATURE_PRESENT", checkConfig: { ...CONFIG, url: "https://shop.example", repository: null } })).toBe(true);
  });

  it("requires a config", () => {
    expect(accepts({ checkConfig: null })).toBe(false);
    expect(accepts({ checkConfig: undefined })).toBe(false);
  });

  it("requires guidance of at least 10 characters and at most 2000", () => {
    expect(accepts({ checkConfig: { sources: ["NOTES"] } })).toBe(false);
    expect(accepts({ checkConfig: { ...CONFIG, guidance: "short" } })).toBe(false);
    expect(accepts({ checkConfig: { ...CONFIG, guidance: "x".repeat(2001) } })).toBe(false);
  });

  it("requires at least one known source, without repeats", () => {
    expect(accepts({ checkConfig: { ...CONFIG, sources: [] } })).toBe(false);
    expect(accepts({ checkConfig: { ...CONFIG, sources: ["EMAIL"] } })).toBe(false);
    expect(accepts({ checkConfig: { ...CONFIG, sources: ["NOTES", "NOTES"] } })).toBe(false);
  });

  it("only allows an https url", () => {
    expect(accepts({ checkConfig: { ...CONFIG, url: "http://shop.example" } })).toBe(false);
    expect(accepts({ checkConfig: { ...CONFIG, url: "file:///etc/passwd" } })).toBe(false);
  });

  it("refuses unknown fields", () => {
    expect(accepts({ checkConfig: { ...CONFIG, autoApprove: true } })).toBe(false);
  });

  // A criterion marked AUTOMATIC counts toward a release on its own, so an AI check under that
  // level would let a model move money. This is the guard for constitution VI at the door.
  it("an AI check cannot be marked AUTOMATIC", () => {
    expect(accepts({ level: "AUTOMATIC" })).toBe(false);
  });

  it("does not touch the other check types", () => {
    expect(accepts({ level: "AUTOMATIC", checkType: "HTTP_PROBE", checkConfig: { url: "https://x.example", method: "GET", expectStatus: 200 } })).toBe(true);
  });
});
