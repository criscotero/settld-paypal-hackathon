// The time as the server sees it, without trusting the browser's clock.
//
// A countdown against the browser's Date.now() is as wrong as that clock: an hour ahead and the
// buyer reads "the window closed" while Core still has it open and they can still object. So the
// page records the server's time when it renders (`server`), the browser records a monotonic
// reading at the same moment (`mono`, performance.now()), and from then on only monotonic time is
// added. A wrong wall clock, or one that changes while the page is open, moves nothing.
//
// What is left: the few hundred milliseconds between the server rendering and the browser starting
// to count, which make the countdown end a little late, never early. At zero the page asks the
// server again (useRefreshWhileEnded) instead of announcing anything itself.

export interface ClockAnchor {
  // Date.now() on the server, when the page rendered.
  readonly server: number;
  // performance.now() in the browser, when it took that anchor.
  readonly mono: number;
}

export function serverTime(anchor: ClockAnchor, monoNow: number): number {
  return anchor.server + (monoNow - anchor.mono);
}

export function secondsUntil(endIso: string, now: number): number {
  return Math.max(0, Math.floor((Date.parse(endIso) - now) / 1000));
}
