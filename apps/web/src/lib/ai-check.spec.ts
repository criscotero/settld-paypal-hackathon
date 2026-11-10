import { describe, expect, it } from "vitest";
import { aiCheckConfig, guidanceOf, keptFieldsOf } from "./ai-check";

describe("aiCheckConfig", () => {
  it("sends the sources the Engine can read", () => {
    expect(aiCheckConfig("Lists three plans", "https://shop.example")).toEqual({ sources: ["HTTP_RESPONSE", "REPOSITORY", "FILES", "NOTES"], guidance: "Lists three plans", url: "https://shop.example" });
  });
  it("an empty url means the link in the delivery", () => {
    expect(aiCheckConfig("Lists three plans", " ").url).toBeNull();
  });
  it("trims what was typed", () => {
    expect(aiCheckConfig("  Lists three plans ", "").guidance).toBe("Lists three plans");
  });
});

describe("editing a draft that already has a config", () => {
  it("keeps the sources and the repository the form does not show", () => {
    const kept = keptFieldsOf({ sources: ["DIFF", "NOTES"], repository: "acme/shop", guidance: "x" });
    expect(aiCheckConfig("New guidance here", "", kept)).toEqual({ sources: ["DIFF", "NOTES"], repository: "acme/shop", guidance: "New guidance here", url: null });
  });
  it("a criterion with no config gets the defaults", () => {
    expect(aiCheckConfig("Lists three plans", "", keptFieldsOf(null)).sources).toEqual(["HTTP_RESPONSE", "REPOSITORY", "FILES", "NOTES"]);
  });
});

describe("guidanceOf", () => {
  it("reads it back when editing", () => {
    expect(guidanceOf({ guidance: "Lists three plans" })).toBe("Lists three plans");
    expect(guidanceOf(null)).toBe("");
    expect(guidanceOf({ guidance: 3 })).toBe("");
  });
});
