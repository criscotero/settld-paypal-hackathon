"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// AG Grid only runs in the browser and is heavy: the rest of the contract form renders first.
export const CriteriaGridLoader = dynamic(() => import("./criteria-grid").then((m) => m.CriteriaGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-40 w-full" />,
});
