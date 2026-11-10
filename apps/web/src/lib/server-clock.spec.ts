import { afterEach, describe, expect, it, vi } from "vitest";
import { secondsUntil, serverTime } from "./server-clock";

const SERVER = Date.parse("2026-11-09T13:30:00Z");
const END = "2026-11-09T14:30:00Z";

afterEach(() => {
  vi.useRealTimers();
});

describe("serverTime", () => {
  it("starts at the server's time and adds only monotonic time", () => {
    const anchor = { server: SERVER, mono: 5_000 };
    expect(serverTime(anchor, 5_000)).toBe(SERVER);
    expect(serverTime(anchor, 65_000)).toBe(SERVER + 60_000);
  });

  it.each([60, -60])("ignores a browser wall clock %i minutes off", (minutes) => {
    // The browser's Date.now() is wrong by an hour; the countdown must not move.
    vi.useFakeTimers();
    vi.setSystemTime(SERVER + minutes * 60_000);
    const anchor = { server: SERVER, mono: 1_000 };
    expect(secondsUntil(END, serverTime(anchor, 1_000))).toBe(3_600);
    expect(secondsUntil(END, serverTime(anchor, 1_000 + 600_000))).toBe(3_000);
  });

  it("ignores a wall clock that changes while the page is open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER);
    const anchor = { server: SERVER, mono: 0 };
    vi.setSystemTime(SERVER + 3 * 3_600_000);
    expect(secondsUntil(END, serverTime(anchor, 10_000))).toBe(3_590);
  });
});

describe("secondsUntil", () => {
  it("counts down to the deadline and stops at zero", () => {
    expect(secondsUntil(END, Date.parse("2026-11-09T14:29:30Z"))).toBe(30);
    expect(secondsUntil(END, Date.parse("2026-11-09T15:00:00Z"))).toBe(0);
  });
});
