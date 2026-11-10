// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditRows } from "@/lib/ai-audit";
import { AiAuditGrid } from "./ai-audit-grid";

beforeAll(() => {
  // jsdom has no layout; AG Grid only needs these to exist.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
});
afterEach(cleanup);

const rows = auditRows(
  [
    {
      criterionId: "c1",
      verdict: "FAIL",
      source: "AI",
      reason: "",
      evidence: [{ snapshotId: "s1", kind: "HTTP_RESPONSE", hash: "sha256:abc", sourceUrl: "https://acme.dev", capturedAt: "2026-11-07T10:00:00Z" }],
      checks: [
        { requirement: "Plans are listed", sourceExcerpt: "plans", verdict: "PASS", finding: "Three plans", evidenceRefs: ["s1"], fix: null, note: null },
        { requirement: "Sales can be contacted", sourceExcerpt: "contact", verdict: "FAIL", finding: "No contact link", evidenceRefs: ["s1"], fix: "Add a link", note: null },
      ],
    },
  ],
  [{ id: "c1", text: "Pricing page" }],
  0,
  "run-1",
);

describe("AiAuditGrid's detail panel (ADR-0022, view 1)", () => {
  it("drops a selected check when the filter hides it, so the panel never describes a hidden row", async () => {
    const { container } = render(<AiAuditGrid rows={rows} />);
    const cell = await screen.findByText("Plans are listed");
    fireEvent.click(cell);
    const panel = () => container.querySelector("aside")?.textContent ?? "";
    await waitFor(() => {
      expect(panel()).toContain("Three plans");
    });
    fireEvent.click(screen.getByRole("button", { name: "Not met" }));
    await waitFor(() => {
      expect(panel()).toContain("Select a check");
    });
    expect(panel()).not.toContain("Three plans");
  });
});
