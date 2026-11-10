// The milestone state machine as code (milestone-state-machine.yaml 1.0.0, ADR-0007).
// state-machine.spec.ts compares this table with the YAML, so the contract and the code cannot
// drift: a transition added to one and not the other fails the build, not production.
//
// The table is data, not behavior. MilestonesService checks each guard explicitly and emits
// each effect explicitly; this table is what it asserts against (assertAllowed), so a method
// can never apply a transition from a state the contract does not allow.
import type { MilestoneState } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";

export type Actor = "BUYER" | "SELLER" | "REVIEWER" | "ADMIN" | "SYSTEM";

export interface Transition {
  readonly id: string;
  readonly from: readonly MilestoneState[];
  readonly to: MilestoneState;
  readonly event: string;
  readonly actors: readonly Actor[];
  readonly guards: readonly string[];
  readonly effects: readonly string[];
}

const t = (id: string, from: MilestoneState[], to: MilestoneState, event: string, actors: Actor[], guards: string[], effects: string[]): Transition => ({
  id,
  from,
  to,
  event,
  actors,
  guards,
  effects,
});

const CAPTURE_EFFECTS = ["E-CAPTURE", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"];

export const TRANSITIONS: readonly Transition[] = [
  t("SM-T01", ["DRAFT"], "APPROVED", "CONTRACT_VERSION_LOCKED", ["SYSTEM"], ["G-LOCKED", "G-MILESTONE-VALID"], ["E-AUDIT", "E-EVENT"]),
  t("SM-T02", ["APPROVED"], "DRAFT", "CONTRACT_AMENDED", ["BUYER", "SELLER"], ["G-NO-ACTIVE-ORDER"], ["E-AUDIT", "E-EVENT"]),
  t("SM-T03", ["APPROVED"], "FUNDED", "AUTHORIZATION_CONFIRMED", ["BUYER", "SYSTEM"], ["G-LOCKED", "G-AUTH-MATCHES", "G-AUTH-ACTIVE"], ["E-LEDGER", "E-SCHEDULE-AUTH-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T04", ["FUNDED"], "IN_PROGRESS", "WORK_STARTED", ["SELLER"], ["G-AUTH-ACTIVE"], ["E-AUDIT", "E-EVENT"]),
  t("SM-T05", ["IN_PROGRESS"], "VERIFYING", "SUBMITTED", ["SELLER"], ["G-AUTH-ACTIVE", "G-EVIDENCE-PRESENT"], ["E-START-RUN", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T06", ["VERIFYING"], "IN_PROGRESS", "VERIFICATION_FAILED", ["SYSTEM"], ["G-RUN-COMPLETE", "G-NOT-RELEASABLE", "G-NOTHING-RELEASED"], ["E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T07", ["VERIFYING"], "OBJECTION_WINDOW", "VERIFICATION_PASSED", ["SYSTEM"], ["G-RUN-COMPLETE", "G-RELEASABLE", "G-PASS-HAS-EVIDENCE", "G-AUTH-ACTIVE"], ["E-OPEN-WINDOW", "E-REAUTHORIZE-IF-NEEDED", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T08", ["OBJECTION_WINDOW"], "RELEASED", "BUYER_APPROVED", ["BUYER"], ["G-NO-OPEN-OBJECTION", "G-REQUIRED-COUNTED", "G-RELEASE-POSITIVE", "G-ALL-COUNTED", "G-NO-RELEASE-IN-FLIGHT", "G-AUTH-ACTIVE"], CAPTURE_EFFECTS),
  t("SM-T09", ["OBJECTION_WINDOW"], "RELEASED", "WINDOW_EXPIRED", ["SYSTEM"], ["G-WINDOW-ELAPSED", "G-NO-OPEN-OBJECTION", "G-SILENCE-IS-APPROVAL", "G-REQUIRED-COUNTED", "G-RELEASE-POSITIVE", "G-ALL-COUNTED", "G-NO-RELEASE-IN-FLIGHT", "G-AUTH-ACTIVE"], CAPTURE_EFFECTS),
  t("SM-T10", ["OBJECTION_WINDOW"], "OBJECTED", "OBJECTION_RAISED", ["BUYER"], ["G-WINDOW-OPEN", "G-OBJECTION-VALID"], ["E-CANCEL-WINDOW-TIMER", "E-SCHEDULE-ESCALATION", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T11", ["OBJECTED"], "VERIFYING", "RESUBMITTED", ["SELLER"], ["G-AUTH-ACTIVE", "G-EVIDENCE-PRESENT", "G-NOT-ESCALATED"], ["E-SUPERSEDE-OBJECTION", "E-CANCEL-ESCALATION", "E-START-RUN", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T12", ["OBJECTED"], "RELEASED", "OBJECTION_WITHDRAWN", ["BUYER"], ["G-REQUIRED-COUNTED", "G-RELEASE-POSITIVE", "G-ALL-COUNTED", "G-NO-RELEASE-IN-FLIGHT", "G-AUTH-ACTIVE"], CAPTURE_EFFECTS),
  t("SM-T13", ["OBJECTED"], "RELEASED", "REVIEWER_RULED_RELEASE", ["REVIEWER", "ADMIN"], ["G-OBJECTION-ESCALATED", "G-REASON-PRESENT", "G-ACTOR-NEUTRAL", "G-NO-RELEASE-IN-FLIGHT", "G-AUTH-ACTIVE"], CAPTURE_EFFECTS),
  t("SM-T14", ["OBJECTED"], "VOIDED", "REVIEWER_RULED_VOID", ["REVIEWER", "ADMIN"], ["G-OBJECTION-ESCALATED", "G-REASON-PRESENT", "G-ACTOR-NEUTRAL", "G-NOTHING-RELEASED"], ["E-VOID", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T15", ["FUNDED", "IN_PROGRESS"], "VOIDED", "CANCELLED_BEFORE_DELIVERY", ["BUYER", "SELLER", "ADMIN"], ["G-NO-SUBMISSION-IN-FLIGHT"], ["E-VOID", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T16", ["DRAFT", "APPROVED"], "VOIDED", "CANCELLED_UNFUNDED", ["BUYER", "SELLER", "ADMIN"], [], ["E-VOID", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT"]),
  t("SM-T17", ["FUNDED", "IN_PROGRESS"], "APPROVED", "AUTHORIZATION_LAPSED", ["SYSTEM"], ["G-AUTH-EXPIRED"], ["E-LEDGER", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T18", ["OBJECTION_WINDOW"], "PARTIALLY_RELEASED", "BUYER_APPROVED", ["BUYER"], ["G-NO-OPEN-OBJECTION", "G-REQUIRED-COUNTED", "G-RELEASE-POSITIVE", "G-SOME-HELD", "G-NO-RELEASE-IN-FLIGHT", "G-AUTH-ACTIVE"], CAPTURE_EFFECTS),
  t("SM-T19", ["OBJECTION_WINDOW"], "PARTIALLY_RELEASED", "WINDOW_EXPIRED", ["SYSTEM"], ["G-WINDOW-ELAPSED", "G-NO-OPEN-OBJECTION", "G-SILENCE-IS-APPROVAL", "G-REQUIRED-COUNTED", "G-RELEASE-POSITIVE", "G-SOME-HELD", "G-NO-RELEASE-IN-FLIGHT", "G-AUTH-ACTIVE"], CAPTURE_EFFECTS),
  t("SM-T20", ["OBJECTED"], "PARTIALLY_RELEASED", "OBJECTION_WITHDRAWN", ["BUYER"], ["G-REQUIRED-COUNTED", "G-RELEASE-POSITIVE", "G-SOME-HELD", "G-NO-RELEASE-IN-FLIGHT", "G-AUTH-ACTIVE"], CAPTURE_EFFECTS),
  t("SM-T21", ["PARTIALLY_RELEASED"], "VERIFYING", "RESUBMITTED", ["SELLER"], ["G-AUTH-ACTIVE", "G-EVIDENCE-PRESENT", "G-NO-RELEASE-IN-FLIGHT"], ["E-START-RUN", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T22", ["PARTIALLY_RELEASED"], "CLOSED", "REMAINDER_RETURNED", ["SELLER", "ADMIN"], ["G-NO-RELEASE-IN-FLIGHT"], ["E-VOID", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T23", ["VERIFYING"], "PARTIALLY_RELEASED", "VERIFICATION_FAILED", ["SYSTEM"], ["G-RUN-COMPLETE", "G-NOT-RELEASABLE", "G-SOME-RELEASED"], ["E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T24", ["OBJECTION_WINDOW"], "IN_PROGRESS", "WINDOW_EXPIRED_NOTHING_COUNTED", ["SYSTEM"], ["G-WINDOW-ELAPSED", "G-NO-OPEN-OBJECTION", "G-NOTHING-COUNTED", "G-NOTHING-RELEASED"], ["E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T25", ["OBJECTION_WINDOW"], "PARTIALLY_RELEASED", "WINDOW_EXPIRED_NOTHING_COUNTED", ["SYSTEM"], ["G-WINDOW-ELAPSED", "G-NO-OPEN-OBJECTION", "G-NOTHING-COUNTED", "G-SOME-RELEASED"], ["E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T26", ["PARTIALLY_RELEASED"], "IN_PROGRESS", "RELEASE_DECLINED", ["SYSTEM"], ["G-NOTHING-RELEASED"], ["E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T27", ["OBJECTED"], "CLOSED", "REVIEWER_RULED_RETURN", ["REVIEWER", "ADMIN"], ["G-OBJECTION-ESCALATED", "G-REASON-PRESENT", "G-ACTOR-NEUTRAL", "G-SOME-RELEASED", "G-NO-RELEASE-IN-FLIGHT"], ["E-VOID", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T28", ["OBJECTED"], "VOIDED", "SELLER_SURRENDERED", ["SELLER"], ["G-NOTHING-RELEASED"], ["E-VOID", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
  t("SM-T29", ["OBJECTED"], "CLOSED", "SELLER_SURRENDERED", ["SELLER"], ["G-SOME-RELEASED", "G-NO-RELEASE-IN-FLIGHT"], ["E-VOID", "E-CANCEL-TIMERS", "E-AUDIT", "E-EVENT", "E-NOTIFY"]),
];

const BY_ID = new Map(TRANSITIONS.map((tr) => [tr.id, tr]));

export function transition(id: string): Transition {
  const tr = BY_ID.get(id);
  if (tr === undefined) throw new Error(`Unknown transition ${id}`);
  return tr;
}

// Refuses a transition the contract does not allow from `state` (409 INVALID_TRANSITION,
// errors.md). Every service method calls this before touching the row.
export function assertAllowed(id: string, state: MilestoneState): Transition {
  const tr = transition(id);
  if (!tr.from.includes(state)) {
    throw new ProblemException("INVALID_TRANSITION", 409, "That is not possible right now", `The milestone is ${state}; ${tr.event} applies only from ${tr.from.join(" or ")}.`, {
      transitionId: id,
      state,
    });
  }
  return tr;
}

// constitution II: only release transitions capture, only return transitions void.
export const moneyEffect = (id: string): "E-CAPTURE" | "E-VOID" | null => {
  const effects = transition(id).effects;
  if (effects.includes("E-CAPTURE")) return "E-CAPTURE";
  if (effects.includes("E-VOID")) return "E-VOID";
  return null;
};
