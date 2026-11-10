// The words the ledger shows. Each state has an icon and a word, never color alone (constitution XII).
import { ArrowUpRight, Circle, Undo2 } from "lucide-react";
import type { Schemas } from "@/lib/api-types";

type Entry = Schemas["LedgerEntry"];

export const EVENT_LABELS: Record<Entry["type"], string> = {
  ORDER_CREATED: "Order created",
  AUTHORIZED: "Authorized",
  REAUTHORIZED: "Reauthorized",
  CAPTURE_REQUESTED: "Capture requested",
  CAPTURED: "Captured",
  CAPTURE_DENIED: "Capture denied",
  VOID_REQUESTED: "Void requested",
  VOIDED: "Voided",
  AUTHORIZATION_EXPIRED: "Authorization expired",
  REFUNDED: "Refunded",
  DISPUTE_OPENED: "Dispute opened",
  DISPUTE_RESOLVED: "Dispute resolved",
};

export const EFFECT_VIEW = {
  PAID: { label: "Paid", tone: "good", Icon: ArrowUpRight },
  RETURNED: { label: "Returned", tone: "warn", Icon: Undo2 },
  NONE: { label: "No money moved", tone: "neutral", Icon: Circle },
} as const;

// Null means the release recorded no run: it counted, but the ledger will not invent why.
export function verdictLabel(verdict: Entry["criteria"][number]["verdict"]): string {
  switch (verdict) {
    case "PASS":
      return "Passed";
    case "FAIL":
      return "Failed";
    case "UNCERTAIN":
      return "Could not check";
    case "NEEDS_HUMAN":
      return "Needs a person";
    case null:
      return "Counted";
  }
}
