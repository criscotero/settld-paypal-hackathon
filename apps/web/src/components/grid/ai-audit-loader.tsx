"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// AG Grid only runs in the browser and is heavy: loaded on its own, like the ledger, so the contract
// page renders its money and buttons first and the audit arrives after.
export const AiAuditLoader = dynamic(() => import("./ai-audit-grid").then((m) => m.AiAuditGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});
