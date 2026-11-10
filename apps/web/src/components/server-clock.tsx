"use client";
// One server clock per page (lib/server-clock.ts). Every countdown on the page reads the same anchor,
// so the dashboard grid and the "Payments on the way" list can never disagree, and none of them
// reads the browser's wall clock.
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { serverTime } from "@/lib/server-clock";
import type { ClockAnchor } from "@/lib/server-clock";

const AnchorContext = createContext<ClockAnchor | null>(null);

// serverNow: Date.now() on the server while it rendered this page. A new render (navigation,
// router.refresh) brings a new one, and the anchor is taken again: it is never older than the page.
export function ServerClock({ serverNow, children }: { serverNow: number; children: ReactNode }) {
  const [anchor, setAnchor] = useState<ClockAnchor>(() => ({ server: serverNow, mono: performance.now() }));
  // Storing the previous prop, as React's docs describe: a new server time resets the anchor in the
  // same render instead of one tick late.
  if (anchor.server !== serverNow) setAnchor({ server: serverNow, mono: performance.now() });
  return <AnchorContext.Provider value={anchor}>{children}</AnchorContext.Provider>;
}

// The server's time now, refreshed every second.
export function useServerNow(): number {
  const anchor = useContext(AnchorContext);
  if (anchor === null) throw new Error("useServerNow needs a <ServerClock> around it: a countdown must not fall back to the browser's clock.");
  const [now, setNow] = useState(() => serverTime(anchor, performance.now()));
  useEffect(() => {
    setNow(serverTime(anchor, performance.now()));
    const id = setInterval(() => {
      setNow(serverTime(anchor, performance.now()));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [anchor]);
  return now;
}

// Shared by every countdown on the page, so several reaching zero together ask once. Not 0:
// performance.now() also starts near 0, and a page opened with a window already at zero would wait.
let lastRefresh = Number.NEGATIVE_INFINITY;

// At zero a countdown announces nothing: it asks the server. Right away, then every 5 s while the
// server still reports the window open (Core's timer job can take a few seconds). The component
// that calls this goes away when the server's answer changes the milestone's state.
export function useRefreshWhileEnded(ended: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!ended) return;
    const refresh = () => {
      const t = performance.now();
      if (t - lastRefresh < 2_000) return;
      lastRefresh = t;
      router.refresh();
    };
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      clearInterval(id);
    };
  }, [ended, router]);
}
