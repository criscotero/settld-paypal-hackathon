// Turns states from Core API into the tracking-page progress bar (one step per
// milestone) and each milestone's history list. Display only: Core API owns the
// state machine, this file only reads where each milestone already is.
import type { Contract, Milestone } from "./api-types";

export type StepStatus = "done" | "current" | "upcoming" | "problem" | "cancelled";

export interface Step {
  id: string;
  title: string;
  status: StepStatus;
}

type MilestoneLike = Pick<Milestone, "id" | "title" | "state">;

// The agreement is step zero: no milestone can move until both parties approved
// the same version (G-LOCKED), so the bar starts there, like "label created".
export function contractSteps(contractStatus: Contract["status"], milestones: MilestoneLike[]): Step[] {
  const agreed = contractStatus === "LOCKED" || contractStatus === "COMPLETED";
  const steps: Step[] = [{ id: "agreement", title: "Agreement", status: agreed ? "done" : "current" }];
  let currentTaken = !agreed;
  for (const ms of milestones) {
    let status: StepStatus;
    if (ms.state === "RELEASED" || ms.state === "CLOSED") status = "done";
    else if (ms.state === "VOIDED") status = "cancelled";
    else if (currentTaken) status = "upcoming";
    else {
      // The first milestone still in play is where attention goes; an objection is
      // still "current", just in a state someone has to resolve.
      status = ms.state === "OBJECTED" ? "problem" : "current";
      currentTaken = true;
    }
    steps.push({ id: ms.id, title: ms.title, status });
  }
  return steps;
}

// Happy path of the state machine (SM-T01, T03, T04, T05, T07, T08/T09).
const PATH = ["APPROVED", "FUNDED", "IN_PROGRESS", "VERIFYING", "OBJECTION_WINDOW", "RELEASED"] as const;

export interface HistoryEntry {
  state: Milestone["state"];
  status: StepStatus;
}

export function milestoneHistory(state: Milestone["state"]): HistoryEntry[] {
  if (state === "VOIDED") return [{ state, status: "cancelled" }];
  // Partial release (ADR-0007): the countdown passed and part was paid. The seller fixes and
  // resubmits (back to VERIFYING), or accepts and the rest returns to the buyer (CLOSED).
  if (state === "PARTIALLY_RELEASED" || state === "CLOSED") {
    const entries: HistoryEntry[] = PATH.filter((s) => s !== "RELEASED").map((s) => ({ state: s, status: "done" }));
    if (state === "CLOSED") return [...entries, { state: "PARTIALLY_RELEASED", status: "done" }, { state: "CLOSED", status: "done" }];
    return [...entries, { state: "PARTIALLY_RELEASED", status: "current" }, { state: "RELEASED", status: "upcoming" }];
  }
  if (state === "OBJECTED") {
    const entries: HistoryEntry[] = PATH.map((s) => ({ state: s, status: s === "RELEASED" ? "upcoming" : "done" }));
    entries.splice(PATH.indexOf("RELEASED"), 0, { state: "OBJECTED", status: "problem" });
    return entries;
  }
  const at = PATH.indexOf(state as (typeof PATH)[number]); // -1 for DRAFT
  return PATH.map((s, i) => ({
    state: s,
    // RELEASED and APPROVED are finished facts, not work in progress: the terms are agreed, and what
    // comes next is funding. Marking APPROVED as current left an agreed contract with nothing done.
    status: i < at || (i === at && (s === "RELEASED" || s === "APPROVED")) ? "done" : i === at ? "current" : "upcoming",
  }));
}
