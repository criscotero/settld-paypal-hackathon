"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// AG Grid only runs in the browser; loaded on its own so the rest of the app does not carry it.
export const ReviewQueueLoader = dynamic(() => import("./review-queue-grid").then((m) => m.ReviewQueueGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-72 w-full" />,
});
