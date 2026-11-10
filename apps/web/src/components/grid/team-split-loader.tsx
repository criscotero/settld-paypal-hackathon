"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// AG Grid only runs in the browser; loaded on its own so the contract's money and buttons come first.
export const TeamSplitLoader = dynamic(() => import("./team-split-grid").then((m) => m.TeamSplitGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-48 w-full" />,
});
