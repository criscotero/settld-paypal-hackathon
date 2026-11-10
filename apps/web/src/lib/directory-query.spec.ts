import { describe, expect, it } from "vitest";
import { directoryHref, parseDirectoryQuery } from "./directory-query";

describe("parseDirectoryQuery", () => {
  it("reads a search, a profession and a cursor", () => {
    expect(parseDirectoryQuery({ q: " react ", profession: "QA_ENGINEER", cursor: "abc" })).toEqual({ q: "react", profession: "QA_ENGINEER", cursor: "abc" });
  });

  it("treats an empty form as no filters", () => {
    expect(parseDirectoryQuery({ q: "  ", profession: "" })).toEqual({ q: "", profession: "", cursor: undefined });
  });

  it("ignores a profession the contract does not define, so an edited link still opens the page", () => {
    expect(parseDirectoryQuery({ profession: "WIZARD" }).profession).toBe("");
  });

  it("cuts the search at the contract's 80 characters, which Core API would otherwise refuse", () => {
    expect(parseDirectoryQuery({ q: "x".repeat(81) }).q).toHaveLength(80);
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(parseDirectoryQuery({ q: ["one", "two"] }).q).toBe("one");
  });

  it("drops a cursor longer than Core API accepts", () => {
    expect(parseDirectoryQuery({ cursor: "c".repeat(201) }).cursor).toBeUndefined();
  });
});

describe("directoryHref", () => {
  it("keeps the filters when moving to the next page", () => {
    expect(directoryHref({ q: "a b", profession: "OTHER" }, "next")).toBe("/directory?q=a+b&profession=OTHER&cursor=next");
  });

  it("leaves out what is empty", () => {
    expect(directoryHref({ q: "", profession: "" })).toBe("/directory");
  });
});
