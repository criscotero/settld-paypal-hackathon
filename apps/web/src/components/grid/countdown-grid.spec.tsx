// @vitest-environment jsdom
// The countdown against a browser clock that is wrong by an hour, either way. Core still has the
// window open; the grid must agree with Core, and at zero it must ask, not announce.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ServerClock } from "@/components/server-clock";
import { Countdown } from "@/components/countdown";
import { countdownRows } from "@/lib/countdown";
import { CountdownGrid } from "./countdown-grid";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh }) }));

beforeAll(() => {
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
  vi.useRealTimers();
  refresh.mockClear();
});

const SERVER = Date.parse("2026-11-09T13:30:00Z");
const rowsEndingIn = (seconds: number) =>
  countdownRows(
    [{ contract: { id: "c", title: "Landing", myRole: "BUYER", counterpartyName: "Sarah" }, milestone: { id: "m", contractId: "c", title: "Published page", amount: { amountMinor: 1000, currency: "USD" }, dueDate: "2099-01-01", state: "OBJECTION_WINDOW", holdStatus: "AUTHORIZED", stateVersion: 1, nextStep: { actor: "BUYER", kind: "X" }, windowEndsAt: new Date(SERVER + seconds * 1000).toISOString() }, myAmount: { amountMinor: 1000, currency: "USD" }, paid: { amountMinor: 0, currency: "USD" } }],
    new Map(),
  );

describe.each([60, -60])("with the browser clock %i minutes off", (minutes) => {
  it("shows the server's time left in the grid and in the list, the same", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SERVER + minutes * 60_000);
    render(
      <ServerClock serverNow={SERVER}>
        <CountdownGrid rows={rowsEndingIn(3_240)} viewerIsBuyer />
        <p data-testid="list">
          <Countdown until={new Date(SERVER + 3_240_000).toISOString()} />
        </p>
      </ServerClock>,
    );
    // 54 minutes, as Core says (53:59 once a few milliseconds have passed); an hour either way on
    // the browser's clock changes nothing.
    const fiftyFour = /^00:5(4:00|3:59)$/;
    await waitFor(() => {
      expect(screen.getAllByText(fiftyFour).length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByTestId("list").textContent).toMatch(fiftyFour);
    expect(screen.queryByText(/Releasing|Confirming/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("at zero", () => {
  it("says Confirming, never Releasing or Paid, and asks the server", async () => {
    render(
      <ServerClock serverNow={SERVER}>
        <CountdownGrid rows={rowsEndingIn(-5)} viewerIsBuyer />
      </ServerClock>,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Confirming/).length).toBeGreaterThan(0);
    });
    // "Paid to" is a column header; what must never appear is the money called released or paid.
    expect(screen.queryByText(/Releasing|^Paid$/)).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });
});
