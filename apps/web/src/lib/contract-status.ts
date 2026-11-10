// What a contract means to the person looking at it: its overall status, whether something waits
// for them, and where it goes in a list. Display only: who acts comes from Milestone.nextStep and
// the approvals Core API returned; nothing here decides a transition.
import type { Contract, Milestone } from "./api-types";
import { awaitsApprovalFrom, draftStep } from "./dashboard";

const TERMINAL: ReadonlySet<Milestone["state"]> = new Set(["RELEASED", "CLOSED", "VOIDED"]);

export type ContractOverview = "DRAFT" | "AWAITING_APPROVAL" | "ACTIVE" | "DISPUTE" | "COMPLETED" | "CANCELLED";

// Core API says LOCKED for an agreed contract forever, so "finished" and "in dispute" are read from
// its milestones. A green "Locked" on a contract nobody can act on said nothing.
export function contractOverview(c: Pick<Contract, "status" | "milestones">): ContractOverview {
  if (c.status === "DRAFT") return "DRAFT";
  if (c.status === "PENDING_APPROVAL") return "AWAITING_APPROVAL";
  if (c.milestones.some((m) => m.state === "OBJECTED")) return "DISPUTE";
  if (c.milestones.length > 0 && c.milestones.every((m) => TERMINAL.has(m.state))) return c.milestones.every((m) => m.state === "VOIDED") ? "CANCELLED" : "COMPLETED";
  return "ACTIVE";
}

const TURN: Record<string, string> = {
  FUND: "Your turn to fund",
  START_WORK: "Your turn to start work",
  SUBMIT: "Your turn to deliver",
  APPROVE_OR_OBJECT: "Your turn to decide",
  RESPOND_TO_OBJECTION: "Your turn to respond",
  FIX_OR_ACCEPT_PARTIAL: "Your turn to fix or accept",
};

export function milestoneTurnLabel(m: Pick<Milestone, "nextStep">): string {
  return TURN[m.nextStep.kind] ?? "Your turn";
}

export interface MyStep {
  label: string;
  // A countdown is running: what nobody decides is not paid.
  urgent: boolean;
  deadline: string | null;
}

// The most pressing thing waiting for this person on this contract, or null.
export function myStep(c: Contract, viewerId: string): MyStep | null {
  const mine = c.milestones.filter((m) => !TERMINAL.has(m.state) && m.nextStep.actor === c.myRole);
  const steps = mine.map((m): MyStep => ({ label: milestoneTurnLabel(m), urgent: m.state === "OBJECTION_WINDOW", deadline: m.windowEndsAt ?? m.dueDate }));
  const first = [...steps].sort(byDeadline)[0];
  if (first !== undefined) return first;
  if (awaitsApprovalFrom(c, viewerId)) return { label: "Your turn to approve the terms", urgent: false, deadline: null };
  const draft = draftStep(c)[0];
  if (draft !== undefined) return { label: draft.kind === "INVITE" ? "Your turn to invite the seller" : "Your turn to send for approval", urgent: false, deadline: null };
  return null;
}

// Earliest first; no deadline goes last. A date and an instant compare correctly as ISO strings.
function byDeadline(a: Pick<MyStep, "deadline">, b: Pick<MyStep, "deadline">): number {
  if (a.deadline === null) return b.deadline === null ? 0 : 1;
  if (b.deadline === null) return -1;
  return a.deadline.localeCompare(b.deadline);
}

// Who the contract is waiting for, when it is not the viewer.
export function turnOfOthers(c: Contract): string {
  const overview = contractOverview(c);
  if (overview === "COMPLETED") return "Every milestone is settled";
  if (overview === "CANCELLED") return "Cancelled";
  if (overview === "DRAFT") return "Terms being written";
  if (overview === "AWAITING_APPROVAL") return "Waiting for the other approvals";
  const next = c.milestones.find((m) => !TERMINAL.has(m.state))?.nextStep.actor;
  return next === "BUYER" ? "Waiting for the buyer" : next === "SELLER" ? "Waiting for the seller" : next === "REVIEWER" ? "Waiting for a reviewer" : next === "SYSTEM" ? "Settld is checking the delivery" : "Waiting";
}

// "What happens next" for a milestone not agreed yet. Core API's nextStep has no actor for a draft,
// and "Nothing to do right now" next to "Your turn to send for approval" contradicts itself.
export function beforeAgreementText(c: Contract, viewerId: string): { mine: boolean; text: string } {
  const step = myStep(c, viewerId);
  return step === null ? { mine: false, text: turnOfOthers(c) } : { mine: true, text: step.label };
}

// Your turn first, soonest deadline on top; then what waits for someone else; then what is closed.
// Inside each group, the most recent activity first.
export function sortContracts<C extends Contract>(contracts: readonly C[], viewerId: string): C[] {
  const rank = (c: C) => (myStep(c, viewerId) !== null ? 0 : ["COMPLETED", "CANCELLED"].includes(contractOverview(c)) ? 2 : 1);
  const activity = (c: C) => c.lastActivityAt ?? "";
  return [...contracts].sort((a, b) => {
    const group = rank(a) - rank(b);
    if (group !== 0) return group;
    if (rank(a) === 0) {
      const soon = byDeadline({ deadline: myStep(a, viewerId)?.deadline ?? null }, { deadline: myStep(b, viewerId)?.deadline ?? null });
      if (soon !== 0) return soon;
    }
    return activity(b).localeCompare(activity(a));
  });
}
