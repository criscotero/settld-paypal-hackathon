"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-runs the Server Component every few seconds so the other party's approval
// shows up without a reload (ADR-0005). router.refresh keeps client state, so a
// half-typed field survives it. Paused while the tab is hidden.
export function AutoRefresh({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => {
      clearInterval(id);
    };
  }, [router, everyMs]);
  return null;
}
