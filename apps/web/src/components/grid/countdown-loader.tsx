"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// AG Grid only runs in the browser; loaded on its own so the dashboard's numbers come first.
export const CountdownLoader = dynamic(() => import("./countdown-grid").then((m) => m.CountdownGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});
