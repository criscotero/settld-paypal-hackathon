import { describe, expect, it } from "vitest";
import { isListed, listingState, openProjectsHref, parseOpenProjectsCursor } from "./open-project";

const NOW = new Date("2026-11-05T12:00:00Z");

describe("listingState", () => {
  it("is not listed without a deadline", () => {
    expect(listingState(null, NOW)).toBe("NOT_LISTED");
  });

  it("is open until the deadline", () => {
    expect(listingState("2026-11-05T12:00:01Z", NOW)).toBe("OPEN");
  });

  it("expires exactly at the deadline, like Core API", () => {
    expect(listingState("2026-11-05T12:00:00Z", NOW)).toBe("EXPIRED");
  });
});

describe("a due date that passed", () => {
  it("makes an open listing overdue, including a date due today", () => {
    expect(listingState("2026-11-20T00:00:00Z", NOW, ["2026-12-01", "2026-11-05"])).toBe("OVERDUE");
  });

  it("does not matter for future dates or an expired listing", () => {
    expect(listingState("2026-11-20T00:00:00Z", NOW, ["2026-11-06"])).toBe("OPEN");
    expect(listingState("2026-11-01T00:00:00Z", NOW, ["2026-11-01"])).toBe("EXPIRED");
  });

  it("still counts as listed, because the contract stays frozen until withdrawn", () => {
    expect(isListed("OVERDUE")).toBe(true);
    expect(isListed("EXPIRED")).toBe(false);
  });
});

describe("parseOpenProjectsCursor", () => {
  it("takes the first of a repeated parameter", () => {
    expect(parseOpenProjectsCursor(["a", "b"])).toBe("a");
  });

  it("drops what Core API would refuse", () => {
    expect(parseOpenProjectsCursor("c".repeat(201))).toBeUndefined();
    expect(parseOpenProjectsCursor("")).toBeUndefined();
  });
});

describe("openProjectsHref", () => {
  it("carries the cursor in the URL", () => {
    expect(openProjectsHref("a+b")).toBe("/contracts/open?cursor=a%2Bb");
  });

  it("is the bare page without one", () => {
    expect(openProjectsHref()).toBe("/contracts/open");
  });
});
