"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// AG Grid only runs in the browser and is heavy. Loading it here keeps it out of every other page's
// bundle, and the skeleton holds the space so the page does not jump when it arrives.
export const LedgerLoader = dynamic(() => import("./ledger-grid").then((m) => m.LedgerGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-[640px] w-full" />,
});
