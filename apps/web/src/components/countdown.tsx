"use client";
// The release countdown (constitution XII: no money moves without a visible countdown).
// Display only: Core's timer decides. It counts with the server's time (components/server-clock.tsx),
// so a wrong browser clock cannot end it early, and at zero it asks the server instead of saying
// anything was released.
import { secondsUntil } from "@/lib/server-clock";
import { clockText } from "@/lib/countdown";
import { useRefreshWhileEnded, useServerNow } from "./server-clock";

export function Countdown({ until }: { until: string }) {
  const left = secondsUntil(until, useServerNow());
  useRefreshWhileEnded(left === 0);
  return (
    // The server's render and the browser's first tick can differ by a second.
    <span role="timer" aria-live="off" className="font-mono tabular-nums" suppressHydrationWarning>
      {clockText(left)}
    </span>
  );
}
