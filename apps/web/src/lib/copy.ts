// Constitution XII: every screen answers "Where is my money, and what happens next?".
// The states and kinds come from Core API (Milestone.holdStatus, Milestone.nextStep);
// this file only turns them into sentences, it never computes them.
import type { Milestone, PartyRole, Schemas } from "./api-types";
import { formatMoney } from "./money";

const KIND: Record<string, string> = {
  APPROVE_CONTRACT_VERSION: "approve the contract",
  FUND: "fund this milestone",
  START_WORK: "start work",
  SUBMIT: "deliver the work",
  WAIT_FOR_VERIFICATION: "verify the delivery",
  APPROVE_OR_OBJECT: "approve or object before the window closes",
  RESPOND_TO_OBJECTION: "respond to the objection",
  AUTO_RELEASE_AT: "release the payment automatically",
  FIX_OR_ACCEPT_PARTIAL: "fix what is missing, or accept the partial payment",
  RULE_ON_OBJECTION: "decide the objection",
};

const ACTOR: Record<Milestone["nextStep"]["actor"], string> = {
  BUYER: "the buyer",
  SELLER: "the seller",
  REVIEWER: "a reviewer",
  SYSTEM: "Settld",
  NONE: "",
};

export function nextStepText(step: Pick<Milestone["nextStep"], "actor" | "kind">, viewer: PartyRole): { mine: boolean; text: string } {
  if (step.actor === "NONE") return { mine: false, text: "Nothing to do right now" };
  // Kinds are an open list in the contract ("e.g. ..."): a new one still renders.
  const what = KIND[step.kind] ?? step.kind.toLowerCase().replaceAll("_", " ");
  if (step.actor === viewer) return { mine: true, text: `You: ${what}` };
  if (step.actor === "SYSTEM") return { mine: false, text: `Settld: ${what}` };
  return { mine: false, text: `Waiting for ${ACTOR[step.actor]}: ${what}` };
}

// Settld never holds funds (constitution I): the money sits in the buyer's PayPal
// (an authorization) until it is captured to the seller or voided.
const HOLD: Record<Schemas["HoldStatus"], string> = {
  NONE: "No money involved yet.",
  ORDER_CREATED: "Payment started; waiting for the buyer to confirm in PayPal.",
  AUTHORIZED: "Reserved on the buyer's PayPal account, not charged yet.",
  CAPTURE_PENDING: "Being paid to the seller.",
  CAPTURED: "Paid to the seller.",
  CAPTURE_FAILED: "Payment to the seller failed; it is being retried.",
  VOID_PENDING: "Being released back to the buyer.",
  VOIDED: "Released back to the buyer; nothing was charged.",
  EXPIRED: "The PayPal reservation expired; the buyer has to fund again.",
};

export function holdText(status: Schemas["HoldStatus"]): string {
  return HOLD[status];
}

// holdStatus alone cannot answer: AUTHORIZED is also a milestone already paid in part, and VOIDED
// also one closed after a partial payment. Saying "not charged yet" or "nothing was charged" there
// is false, and it is the one question this line exists for (constitution XII). No amounts: the
// breakdown right below has them, scoped to what this viewer may see.
export function moneyText(m: Pick<Milestone, "state" | "holdStatus" | "released">, hasTeam: boolean): string {
  const who = hasTeam ? "the team" : "the seller";
  const somethingReleased = (m.released?.amountMinor ?? 0) > 0;
  switch (m.holdStatus) {
    case "CAPTURE_PENDING":
      return `Being paid to ${who}.`;
    case "CAPTURED":
      return `Paid to ${who}.`;
    // Never retried with a new request id (state machine, CAPTURE_FAILED), so it cannot say it is.
    case "CAPTURE_FAILED":
      return `PayPal declined the payment to ${who}. It is not retried automatically: Settld has to review it.`;
    // Funding again is only possible from APPROVED; anywhere later it is an incident (SM-INV-6).
    case "EXPIRED":
      return m.state === "APPROVED" ? HOLD.EXPIRED : "The PayPal reservation expired. Settld has to review this milestone.";
    case "VOID_PENDING":
      return somethingReleased ? `Part was paid to ${who}; the rest is being returned to the buyer.` : HOLD.VOID_PENDING;
    case "VOIDED":
      return somethingReleased ? `Part was paid to ${who}; the rest was returned to the buyer.` : HOLD.VOIDED;
    case "AUTHORIZED":
      return somethingReleased ? `Part was paid to ${who}; the rest is reserved on the buyer's PayPal account, not charged.` : HOLD.AUTHORIZED;
    default:
      return HOLD[m.holdStatus];
  }
}

// Why the seller has the next step again. Says what happened, where the money is and who acts, so
// the missing button does not look like a bug (constitution XII).
export function returnNotice(m: Pick<Milestone, "returnReason" | "held" | "released" | "amount">, viewer: PartyRole): { title: string; text: string } | null {
  if (m.returnReason == null) return null;
  const held = formatMoney(m.held ?? m.amount);
  const paid = (m.released?.amountMinor ?? 0) > 0;
  const money = paid ? `What was already paid stands, and ${held} stays reserved.` : `Nothing was paid, and ${held} stays reserved.`;
  const next = viewer === "BUYER" ? "Now the seller has to deliver again." : viewer === "SELLER" ? "Now it is your turn to deliver again." : "Now the seller has to deliver again.";
  switch (m.returnReason) {
    case "WINDOW_EXPIRED":
      return { title: "The countdown ended without a decision", text: `The buyer did not decide in time. ${money} ${next}` };
    case "VERIFICATION_FAILED":
      return { title: "The delivery did not pass the checks", text: `A required check failed. ${money} ${next}` };
    case "RELEASE_DECLINED":
      return { title: "PayPal declined the payment", text: `${money} ${next}` };
  }
}

export function humanize(value: string): string {
  const s = value.toLowerCase().replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// History entries read like tracking events ("Out for delivery"), not state names.
const EVENT: Record<Milestone["state"], string> = {
  DRAFT: "Terms being written",
  APPROVED: "Terms agreed by both parties",
  FUNDED: "Funded: money reserved in the buyer's PayPal",
  IN_PROGRESS: "Work in progress",
  VERIFYING: "Delivered: Settld is verifying the work",
  OBJECTION_WINDOW: "Verified: buyer can object until the window closes",
  OBJECTED: "Objection raised: on hold until resolved",
  PARTIALLY_RELEASED: "Partly paid: the rest stays reserved until the seller fixes it",
  RELEASED: "Paid to the seller",
  CLOSED: "Closed: partly paid, the rest returned to the buyer",
  VOIDED: "Cancelled: money returned to the buyer",
};

export function eventText(state: Milestone["state"]): string {
  return EVENT[state];
}

const CHECK: Record<string, string> = {
  HTTP_PROBE: "HTTP probe",
  GITHUB_PR_MERGED: "GitHub pull request merged",
  CI_STATUS_GREEN: "CI is green",
  TESTS_PASSED: "Tests passed",
  AI_FEATURE_PRESENT: "AI: feature present",
  AI_REQUIREMENT_MET: "AI: requirement met",
};

export function checkLabel(checkType: string): string {
  return CHECK[checkType] ?? humanize(checkType);
}
