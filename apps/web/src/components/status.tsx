import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock, FileEdit, FileSignature, Hand, HandCoins, Loader, PlayCircle, ShieldAlert, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Milestone } from "@/lib/api-types";
import type { ContractOverview } from "@/lib/contract-status";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "warn" | "good" | "bad";
interface Look {
  tone: Tone;
  icon: LucideIcon;
  label: string;
}

// Constitution XII: color, icon and word, never color alone. One meaning per color across the app:
// green is settled, blue is moving, amber waits on a clock or a signature, red is a dispute, gray
// is not in play. Labels are the contract's (milestone-state-machine.md, section 1).
const CONTRACT: Record<ContractOverview, Look> = {
  DRAFT: { tone: "neutral", icon: FileEdit, label: "Draft" },
  AWAITING_APPROVAL: { tone: "warn", icon: FileSignature, label: "Awaiting approval" },
  ACTIVE: { tone: "info", icon: PlayCircle, label: "Active" },
  DISPUTE: { tone: "bad", icon: ShieldAlert, label: "In dispute" },
  COMPLETED: { tone: "good", icon: CheckCircle2, label: "Completed" },
  CANCELLED: { tone: "neutral", icon: Ban, label: "Cancelled" },
};

const MILESTONE: Record<Milestone["state"], Look> = {
  DRAFT: { tone: "neutral", icon: FileEdit, label: "Draft" },
  APPROVED: { tone: "info", icon: Wallet, label: "Ready to fund" },
  FUNDED: { tone: "info", icon: Wallet, label: "Funded" },
  IN_PROGRESS: { tone: "info", icon: PlayCircle, label: "In progress" },
  VERIFYING: { tone: "info", icon: Loader, label: "Verifying" },
  OBJECTION_WINDOW: { tone: "warn", icon: Clock, label: "Release countdown" },
  OBJECTED: { tone: "bad", icon: AlertTriangle, label: "Objection open" },
  PARTIALLY_RELEASED: { tone: "warn", icon: HandCoins, label: "Partly released" },
  RELEASED: { tone: "good", icon: CheckCircle2, label: "Released" },
  CLOSED: { tone: "neutral", icon: CircleDashed, label: "Closed" },
  VOIDED: { tone: "neutral", icon: Ban, label: "Cancelled" },
};

function StatusBadge({ look }: { look: Look }) {
  const Icon = look.icon;
  return (
    <Badge tone={look.tone}>
      <Icon className="size-3.5" aria-hidden />
      {look.label}
    </Badge>
  );
}

export function ContractStatus({ status }: { status: ContractOverview }) {
  return <StatusBadge look={CONTRACT[status]} />;
}

export function MilestoneState({ state }: { state: Milestone["state"] }) {
  return <StatusBadge look={MILESTONE[state]} />;
}

// The one solid badge in the app: it has to be found at a glance. White on orange-700 or red-700
// keeps a contrast above 4.5:1. Red only while a countdown runs.
export function YourTurn({ label, urgent = false }: { label: string; urgent?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-white", urgent ? "bg-red-700" : "bg-orange-700")}>
      <Hand className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
