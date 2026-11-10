// @vitest-environment jsdom
// ADR-0022, failure modes: text from the seller, the buyer or the model is shown as text, never run
// as HTML. Each grid is rendered with markup in every text it shows; the DOM must contain the
// characters, and no element the markup would have created.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditRows } from "@/lib/ai-audit";
import { countdownRows } from "@/lib/countdown";
import { reviewRows } from "@/lib/review-queue";
import { AiAuditGrid } from "./ai-audit-grid";
import { CountdownGrid } from "./countdown-grid";
import { ServerClock } from "@/components/server-clock";
import { CriteriaGrid } from "./criteria-grid";
import { ReviewQueueGrid } from "./review-queue-grid";
import { TeamSplitGrid } from "./team-split-grid";
import { teamSplit } from "@/lib/team-split";

// The queue opens a case with the App Router, which only exists inside Next.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const SCRIPT = "<script>window.pwned = 1</script>";
const IMG = '<img src="x" onerror="window.pwned = 1">';
const ATTACKS = [SCRIPT, IMG];

beforeAll(() => {
  // jsdom has no layout. AG Grid only needs these to exist; sizes of 0 are fine for a DOM check.
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

afterEach(() => {
  cleanup();
  delete (window as { pwned?: number }).pwned;
});

// Nothing the attack strings would create, and nothing they would have run.
function expectInert(container: HTMLElement) {
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect((window as { pwned?: number }).pwned).toBeUndefined();
}

describe.each(ATTACKS)("text cells render %s literally", (attack) => {
  it("view 1: the AI audit grid and its detail panel", async () => {
    const rows = auditRows(
      [
        {
          criterionId: "c1",
          verdict: "FAIL",
          source: "AI",
          reason: "",
          evidence: [{ snapshotId: "s1", kind: "HTTP_RESPONSE", hash: "sha256:abc", sourceUrl: `https://acme.dev/${attack}`, capturedAt: "2026-11-07T10:00:00Z" }],
          injectionFlags: [{ evidenceSnapshotId: "s1", excerpt: attack, kind: "INSTRUCTION_TO_AI" }],
          checks: [{ requirement: attack, sourceExcerpt: attack, verdict: "FAIL", finding: attack, evidenceRefs: ["s1"], fix: attack, note: attack }],
        },
      ],
      [{ id: "c1", text: attack }],
      0,
      "run-1",
    );
    const { container } = render(<AiAuditGrid rows={rows} />);
    await waitFor(() => {
      expect(screen.getAllByText(attack, { exact: false }).length).toBeGreaterThan(0);
    });
    // Open the detail panel, where every field of the check is shown.
    screen.getAllByText(attack)[0]?.closest("[role=row]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(container.querySelector("aside")?.textContent).toContain(`Found in the evidence: “${attack}”`);
    });
    expect(container.querySelector("aside")?.textContent).toContain(`https://acme.dev/${attack}`);
    expectInert(container);
  });

  it("view 5: the reviewer queue", async () => {
    const rows = reviewRows(
      [{ objection: { id: "o1", milestoneId: "m", runId: "r", criterionIds: [], reason: attack, status: "ESCALATED", raisedAt: "2026-11-01T00:00:00Z", escalateAt: "2026-11-05T00:00:00Z" }, contractId: "c", contractTitle: attack, milestoneTitle: attack, amount: { amountMinor: 100, currency: "USD" }, buyerName: attack, sellerName: attack }],
      new Date("2026-11-07T00:00:00Z"),
    );
    const { container } = render(<ReviewQueueGrid rows={rows} />);
    await waitFor(() => {
      expect(screen.getAllByText(attack).length).toBeGreaterThanOrEqual(5);
    });
    expectInert(container);
  });

  it("view 4: the release countdown", async () => {
    const rows = countdownRows(
      [{ contract: { id: "c", title: attack, myRole: "BUYER", counterpartyName: attack }, milestone: { id: "m", contractId: "c", title: attack, amount: { amountMinor: 100, currency: "USD" }, dueDate: "2099-01-01", state: "OBJECTION_WINDOW", holdStatus: "AUTHORIZED", stateVersion: 1, nextStep: { actor: "BUYER", kind: "X" }, windowEndsAt: "2099-01-01T00:00:00Z" }, myAmount: { amountMinor: 100, currency: "USD" }, paid: { amountMinor: 0, currency: "USD" } }],
      new Map(),
    );
    const { container } = render(
      <ServerClock serverNow={Date.now()}>
        <CountdownGrid rows={rows} viewerIsBuyer />
      </ServerClock>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(attack).length).toBeGreaterThanOrEqual(3);
    });
    expectInert(container);
  });

  it("ADR-0024: who gets what, names and roles", async () => {
    const member = (userId: string, isSeller: boolean, shareBps: number) => ({ userId, displayName: attack, role: attack, shareBps, isSeller, approvedCurrentVersion: true, professions: [], headline: null });
    const split = teamSplit(
      { myRole: "BUYER", team: [member("s", true, 7000), member("a", false, 3000)], milestones: [{ id: "m", contractId: "c", title: attack, amount: { amountMinor: 1000, currency: "USD" }, dueDate: "2099-01-01", state: "APPROVED", holdStatus: "NONE", stateVersion: 1, nextStep: { actor: "BUYER", kind: "X" } }] },
      "buyer",
    );
    const { container } = render(<TeamSplitGrid split={split} />);
    await waitFor(() => {
      expect(screen.getAllByText(attack).length).toBeGreaterThanOrEqual(2);
    });
    expectInert(container);
  });

  it("view 2: every editable text cell of the criteria editor", async () => {
    const criteria = [
      { key: 1, text: attack, level: "AUTOMATIC" as const, checkType: "HTTP_PROBE" as const, probeUrl: attack, guidance: "", weight: attack, required: true, rationale: attack },
      { key: 2, text: attack, level: "AI_EVALUATED" as const, checkType: "AI_REQUIREMENT_MET" as const, probeUrl: "", guidance: attack, weight: "50", required: false },
    ];
    const { container } = render(<CriteriaGrid criteria={criteria} codes={new Map([[1, "M1-C1"], [2, "M1-C2"]])} onChange={() => undefined} onRemove={() => undefined} registerFlush={() => undefined} />);
    await waitFor(() => {
      // Text of both rows, the probe's URL, the AI guidance and the weight as typed.
      expect(screen.getAllByText(attack).length).toBeGreaterThanOrEqual(5);
    });
    expect(screen.getByText("M1-C2")).toBeTruthy();
    expectInert(container);
  });
});
