import { toActionError } from "./problem";

describe("toActionError", () => {
  it("keeps Core API's own title and detail (errors.md)", () => {
    const e = toActionError({ type: "about:blank", title: "The contract changed", status: 409, code: "VERSION_HASH_MISMATCH", detail: "Reload and review it again.", requestId: "r1" });
    expect(e).toEqual({ code: "VERSION_HASH_MISMATCH", message: "The contract changed. Reload and review it again.", issues: [], requestId: "r1" });
  });

  it("lists field issues from VALIDATION_FAILED", () => {
    const e = toActionError({
      type: "about:blank",
      title: "Invalid request",
      status: 422,
      code: "VALIDATION_FAILED",
      requestId: "r2",
      context: { issues: [{ path: "milestones.0.title", message: "Too small" }] } as never,
    });
    expect(e.issues).toEqual(["Milestone 1 › title: Too small"]);
  });

  it("survives a body that is not a problem (proxy error page, empty body)", () => {
    expect(toActionError("<html>Bad gateway</html>")).toEqual({ code: "INTERNAL", message: "Core API returned an unexpected response.", issues: [], requestId: null });
  });
});
