// Everything a dashboard shows, derived from the contracts Core API returned for this user.
// Display only: who acts next comes from Milestone.nextStep (Core API) and where the money
// is from Milestone.holdStatus; nothing here decides a transition.
import type { Contract, Milestone, PartyRole, Schemas } from "./api-types";
import { releaseTotals } from "./released";
import { splitRemainderToSeller } from "./split";
import { totalsByCurrency } from "./totals";
import { isListed, listingState } from "./open-project";

type Money = Schemas["Money"];

export interface MilestoneRef {
  contract: Pick<Contract, "id" | "title" | "myRole" | "counterpartyName">;
  milestone: Milestone;
  // What this milestone is worth to the viewer: the whole of it for a buyer, their part for a team member.
  myAmount: Money;
  // What PayPal has actually paid of it: less than myAmount on a milestone closed in part.
  paid: Money;
}

export interface ApprovalRef {
  contract: Pick<Contract, "id" | "title" | "myRole" | "counterpartyName" | "total">;
  version: number;
}

// A step on the agreement that is not a signature: nobody else will tell them it is theirs.
export interface DraftStep {
  kind: "SUBMIT" | "INVITE";
  contract: Pick<Contract, "id" | "title" | "counterpartyName">;
  version: number;
}

// A version the viewer has done their part on, and who it still needs.
export interface WaitingAgreement {
  contract: Pick<Contract, "id" | "title">;
  version: number;
  waitingFor: string[];
}

// Where the money is, from the point of view of either party. Ordered from settled to not
// yet committed, which is also the order of the chart segments.
export interface MoneyBuckets {
  currency: string;
  paid: number; // captured by PayPal
  reserved: number; // authorized in the buyer's PayPal, not captured yet (a capture in progress included)
  unfunded: number; // agreed (APPROVED) but nothing reserved yet
}

// ORDER_CREATED is not here: the buyer opened PayPal but approved nothing, so no money is
// reserved yet and the milestone still counts as unfunded.
const RESERVED: ReadonlySet<Schemas["HoldStatus"]> = new Set(["AUTHORIZED", "CAPTURE_PENDING", "CAPTURE_FAILED", "VOID_PENDING"]);
const OPEN_STATES: ReadonlySet<Milestone["state"]> = new Set(["APPROVED", "FUNDED", "IN_PROGRESS", "VERIFYING", "OBJECTION_WINDOW", "OBJECTED", "PARTIALLY_RELEASED"]);
// Work handed in: the due date no longer applies, only the check and the window do.
export const DELIVERED_STATES: ReadonlySet<Milestone["state"]> = new Set(["VERIFYING", "OBJECTION_WINDOW"]);

const hasTeam = (c: Contract) => c.myRole !== "BUYER" && (c.team?.length ?? 0) > 1;

// A team member's part before PayPal authorizes it, with the rule of Core API's orders. Holds do
// not exist until the first /fund, so this reads the team. A collaborator gets only their own
// share (decision 6); the others count as 0, which leaves the floor of their own part untouched
// because the leftover cents go to the seller's entry.
function plannedPart(c: Contract, m: Milestone, viewerId: string): number {
  const team = c.team ?? [];
  const parts = splitRemainderToSeller(m.amount.amountMinor, team.map((t) => t.shareBps ?? 0));
  return parts[team.findIndex((t) => t.userId === viewerId)] ?? 0;
}

function myAmount(c: Contract, m: Milestone, viewerId: string): Money {
  if (!hasTeam(c)) return m.amount;
  const funded = m.holds?.find((h) => h.payeeUserId === viewerId)?.funded.amountMinor ?? 0;
  return { amountMinor: funded > 0 ? funded : plannedPart(c, m, viewerId), currency: m.amount.currency };
}

function paidBy(c: Contract, m: Milestone, viewerId: string): number {
  return releaseTotals(m, hasTeam(c) ? viewerId : undefined).captured;
}

export function moneyBuckets(contracts: Contract[], role: PartyRole, viewerId: string): MoneyBuckets[] {
  const by = new Map<string, MoneyBuckets>();
  for (const c of contracts.filter((x) => x.myRole === role)) {
    for (const m of c.milestones) {
      const b = by.get(m.amount.currency) ?? { currency: m.amount.currency, paid: 0, reserved: 0, unfunded: 0 };
      // Each person has their own PayPal authorization (ADR-0009). The milestone's totals add up
      // the whole team, which would show every member the full amount as theirs.
      const hold = hasTeam(c) ? m.holds?.find((h) => h.payeeUserId === viewerId) : undefined;
      const paid = paidBy(c, m, viewerId);
      // Authorized minus what moved. Not holdStatus: a milestone waiting for one team member's
      // approval reports ORDER_CREATED while another member's money is already reserved.
      const funded = hasTeam(c) ? (hold?.funded.amountMinor ?? 0) : (m.funded?.amountMinor ?? (RESERVED.has(m.holdStatus) ? m.amount.amountMinor : paid));
      const returned = hasTeam(c) ? (hold?.returned.amountMinor ?? 0) : (m.returned?.amountMinor ?? 0);
      // An expired or declined authorization may hold nothing any more: not worth calling "secured".
      const gone = ["EXPIRED", "CAPTURE_FAILED"].includes(hold?.holdStatus ?? m.holdStatus);
      const reserved = gone ? 0 : Math.max(0, funded - paid - returned);
      b.paid += paid;
      b.reserved += reserved;
      if (m.state === "APPROVED" && reserved === 0) b.unfunded += hasTeam(c) ? plannedPart(c, m, viewerId) : m.amount.amountMinor;
      // The rest of a milestone funded only in part. A team member's own part is all or nothing.
      else if (m.state === "APPROVED" && !hasTeam(c)) b.unfunded += m.amount.amountMinor - reserved;
      by.set(b.currency, b);
    }
  }
  return [...by.values()].filter((b) => b.paid + b.reserved + b.unfunded > 0).sort((a, b) => total(b) - total(a));
}

const total = (b: MoneyBuckets) => b.paid + b.reserved + b.unfunded;

export interface Dashboard {
  role: PartyRole;
  contracts: Contract[];
  // The viewer has to do something: a milestone step or approving a pending version.
  myMilestones: MilestoneRef[];
  myApprovals: ApprovalRef[];
  myDraftSteps: DraftStep[];
  waitingAgreements: WaitingAgreement[];
  // Someone else (the other party or Settld) has to act.
  waiting: MilestoneRef[];
  // Money moving to the seller soon: delivered and being checked or in the window.
  incoming: MilestoneRef[];
  // In the objection window, the one ending first on top (ADR-0022, view 4).
  inWindow: MilestoneRef[];
  recentlyPaid: MilestoneRef[];
  upcoming: MilestoneRef[];
  money: MoneyBuckets[];
  activeContracts: number;
}

function ref(c: Contract, m: Milestone, viewerId: string): MilestoneRef {
  return { contract: { id: c.id, title: c.title, myRole: c.myRole, counterpartyName: c.counterpartyName }, milestone: m, myAmount: myAmount(c, m, viewerId), paid: { amountMinor: paidBy(c, m, viewerId), currency: m.amount.currency } };
}

const byDue = (a: MilestoneRef, b: MilestoneRef) => a.milestone.dueDate.localeCompare(b.milestone.dueDate);

// A running countdown comes first: it ends by itself, and a due date does not.
function byUrgency(a: MilestoneRef, b: MilestoneRef): number {
  const [x, y] = [a.milestone.windowEndsAt, b.milestone.windowEndsAt];
  if (x != null && y != null) return x.localeCompare(y);
  if (x != null) return -1;
  if (y != null) return 1;
  return byDue(a, b);
}

function approvedHash(c: Contract, viewerId: string): boolean {
  return c.currentVersion.approvals.some((a) => a.userId === viewerId && a.snapshotHash === c.currentVersion.snapshotHash);
}

export function awaitsApprovalFrom(c: Contract, viewerId: string): boolean {
  if (c.currentVersion.status !== "PENDING_APPROVAL" || approvedHash(c, viewerId)) return false;
  // Core API refuses a collaborator the version's team does not name (they may have been removed).
  return c.myRole !== "COLLABORATOR" || (c.team ?? []).some((t) => t.userId === viewerId && !t.isSeller);
}

// One step per contract, the first one that unblocks it. An invitation already out is not a step
// any more (openapi 0.17.0, pendingInvitation): after inviting, the page kept saying "Your turn to
// invite the seller" (live test 2026-11-07). The buyer can still send the draft for approval.
export function draftStep(c: Contract): DraftStep[] {
  const base = { contract: { id: c.id, title: c.title, counterpartyName: c.counterpartyName }, version: c.currentVersion.version };
  if (c.myRole === "BUYER" && c.currentVersion.status !== "LOCKED" && c.sellerId == null && c.pendingInvitation == null) {
    // A listed project waits for a seller to take it, and Core API would refuse an invitation.
    const listed = isListed(listingState(c.publishedUntil, new Date(), c.milestones.map((m) => m.dueDate)));
    return listed ? [] : [{ kind: "INVITE", ...base }];
  }
  if (c.myRole !== "COLLABORATOR" && c.currentVersion.status === "DRAFT") return [{ kind: "SUBMIT", ...base }];
  return [];
}

function stillToApprove(c: Contract): string[] {
  const v = c.currentVersion;
  const has = (role: PartyRole) => v.approvals.some((a) => a.partyRole === role && a.snapshotHash === v.snapshotHash);
  return [
    ...(has("BUYER") ? [] : ["the buyer"]),
    ...(has("SELLER") ? [] : ["the seller"]),
    ...(c.team ?? []).filter((t) => !t.isSeller && !t.approvedCurrentVersion).map((t) => t.displayName),
  ];
}

// Which dashboards this person has. Their contracts decide as much as their chosen roles: a seller
// added to someone's team is a collaborator there, with no COLLABORATOR role, and with a filter on
// roles alone the approval that contract is waiting for was shown nowhere.
const VIEW_ORDER: readonly PartyRole[] = ["BUYER", "SELLER", "COLLABORATOR"];

export function availableViews(roles: readonly string[], contracts: readonly Pick<Contract, "myRole">[]): PartyRole[] {
  return VIEW_ORDER.filter((v) => roles.includes(v) || contracts.some((c) => c.myRole === v));
}

export function actionCount(d: Pick<Dashboard, "myMilestones" | "myApprovals" | "myDraftSteps">): number {
  return d.myMilestones.length + d.myApprovals.length + d.myDraftSteps.length;
}

export function buildDashboard(all: Contract[], role: PartyRole, viewerId: string): Dashboard {
  const contracts = all.filter((c) => c.myRole === role);
  const refs = contracts.flatMap((c) => c.milestones.map((m) => ref(c, m, viewerId)));
  const open = refs.filter((r) => OPEN_STATES.has(r.milestone.state));

  // By person, not by role (ADR-0009): a version may need several collaborators, and one of them
  // approving must not take the step away from the others.
  const myApprovals = contracts
    .filter((c) => awaitsApprovalFrom(c, viewerId))
    .map((c) => ({ contract: { id: c.id, title: c.title, myRole: c.myRole, counterpartyName: c.counterpartyName, total: c.total }, version: c.currentVersion.version }));

  const myDraftSteps = contracts.flatMap((c) => draftStep(c));
  const waitingAgreements = contracts
    .filter((c) => c.currentVersion.status === "PENDING_APPROVAL" && !awaitsApprovalFrom(c, viewerId))
    .map((c) => ({ contract: { id: c.id, title: c.title }, version: c.currentVersion.version, waitingFor: stillToApprove(c) }));

  const incoming = refs.filter((r) => DELIVERED_STATES.has(r.milestone.state)).sort(byDue);
  const others = open.filter((r) => r.milestone.nextStep.actor !== role && r.milestone.nextStep.actor !== "NONE");

  return {
    role,
    contracts,
    myMilestones: open.filter((r) => r.milestone.nextStep.actor === role).sort(byUrgency),
    myApprovals,
    myDraftSteps,
    waitingAgreements,
    // Whoever is paid sees delivered work under "incoming" already; listing it twice is noise.
    waiting: (role !== "BUYER" ? others.filter((r) => !DELIVERED_STATES.has(r.milestone.state)) : others).sort(byDue),
    incoming,
    inWindow: refs.filter((r) => r.milestone.state === "OBJECTION_WINDOW" && r.milestone.windowEndsAt != null).sort(byUrgency),
    recentlyPaid: refs.filter((r) => r.paid.amountMinor > 0).sort((a, b) => byDue(b, a)),
    upcoming: open.filter((r) => !DELIVERED_STATES.has(r.milestone.state)).sort(byDue),
    money: moneyBuckets(contracts, role, viewerId),
    activeContracts: contracts.filter((c) => c.status === "LOCKED" && c.milestones.some((m) => OPEN_STATES.has(m.state))).length,
  };
}

export function sumBy(buckets: MoneyBuckets[], key: "paid" | "reserved" | "unfunded"): Money[] {
  return totalsByCurrency(buckets.map((b) => ({ amountMinor: b[key], currency: b.currency }))).filter((m) => m.amountMinor > 0);
}

// How each party role reads to a person, in one place: the dashboard greeting, the contract list and
// the contract's details all use it. A collaborator is on the seller's team, but is not the seller.
export const PARTY_ROLE_LABEL: Record<PartyRole, string> = { BUYER: "Buyer", SELLER: "Seller", COLLABORATOR: "Collaborator" };

// The word in the greeting. QA is earned: only the role says so, and the role only comes from an
// approved application, so a pending applicant is still greeted by what they are today. A buyer or
// seller who also reviews is greeted by the dashboard they are looking at.
export function greetingRole(roles: readonly string[], view: PartyRole): string {
  const party = roles.includes("BUYER") || roles.includes("SELLER");
  return roles.includes("REVIEWER") && !party ? "QA" : PARTY_ROLE_LABEL[view];
}

// What PayPal paid over time, for the charts: from the parts PayPal captured, by when the release
// was decided (a capture settles right after). A team member's are their own parts.
export interface PaidHistory {
  currency: string;
  total: number;
  months: { key: string; label: string; amount: number }[];
  byParty: { name: string; amount: number }[];
}

const MONTH_LABEL = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });

// In one currency, the largest: amounts in two are never added together. null: nothing paid yet.
export function paidHistory(contracts: readonly Contract[], role: PartyRole, viewerId: string, now: Date = new Date(), monthCount = 6): PaidHistory | null {
  const entries = contracts
    .filter((c) => c.myRole === role)
    .flatMap((c) =>
      c.milestones.flatMap((m) =>
        (m.releases ?? []).flatMap((r) =>
          (r.parts ?? [])
            .filter((p) => p.status === "CAPTURED" && (!hasTeam(c) || p.payeeUserId === viewerId))
            .map((p) => ({ at: r.decidedAt, amount: p.amount.amountMinor, currency: p.amount.currency, party: c.counterpartyName ?? "Not named" })),
        ),
      ),
    );
  const byCurrency = new Map<string, number>();
  for (const e of entries) byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.amount);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (currency === undefined) return null;
  const own = entries.filter((e) => e.currency === currency);

  const months = Array.from({ length: monthCount }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthCount - 1 - i), 1));
    const key = d.toISOString().slice(0, 7);
    return { key, label: MONTH_LABEL.format(d), amount: own.filter((e) => e.at.startsWith(key)).reduce((sum, e) => sum + e.amount, 0) };
  });
  const parties = new Map<string, number>();
  for (const e of own) parties.set(e.party, (parties.get(e.party) ?? 0) + e.amount);
  return {
    currency,
    total: own.reduce((sum, e) => sum + e.amount, 0),
    months,
    byParty: [...parties.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, 5),
  };
}

// The top of the axis: the first round number at or above the peak, in minor units.
export function niceCeiling(peakMinor: number): number {
  if (peakMinor <= 0) return 10_000;
  const magnitude = 10 ** Math.floor(Math.log10(peakMinor));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= peakMinor) ?? 10;
  return step * magnitude;
}
