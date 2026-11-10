// Maps rows to the API shapes in openapi.yaml (Contract, ContractSummary, ContractVersion,
// Milestone). Returns plain JSON (dates as ISO strings) so an idempotent replay of a stored
// response is byte-for-byte the same as the original.
import { and, asc, desc, eq, gt, inArray, isNull, like, max } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { auditLog, contractApprovals, contractParties, contracts, contractVersions, holds, invitations, milestones, objections, releaseParts, releases, users } from "../db/schema.js";
import type { PartyRole } from "../db/schema.js";
import { platformFee } from "../payments/release-math.js";
import { LOW_VERIFIABILITY, verifiabilityScore } from "./snapshot.js";
import { teamOf } from "./snapshot.js";
import type { ContractSnapshot, Money, SnapshotMilestone } from "./snapshot.js";

type Q = Db | Tx;
type ContractRow = typeof contracts.$inferSelect;
type VersionRow = typeof contractVersions.$inferSelect;
type MilestoneRow = typeof milestones.$inferSelect;
type ReleaseRow = typeof releases.$inferSelect;
type HoldRow = typeof holds.$inferSelect;
type PartRow = typeof releaseParts.$inferSelect;
export const LIVE_OBJECTION = ["OPEN", "CONTESTED", "ESCALATED"] as const;

export function partyRoleOf(contract: ContractRow, userId: string): PartyRole | null {
  if (contract.buyerId === userId) return "BUYER";
  if (contract.sellerId === userId) return "SELLER";
  return null;
}

// Buyer and seller live on the contract row; collaborators in contract_parties (ADR-0009).
// Every party check goes through here, so "who may see this contract" has one answer.
export async function partyRoleIn(q: Q, contract: ContractRow, userId: string): Promise<PartyRole | null> {
  const direct = partyRoleOf(contract, userId);
  if (direct !== null) return direct;
  const [row] = await q.select({ role: contractParties.partyRole }).from(contractParties).where(and(eq(contractParties.contractId, contract.id), eq(contractParties.userId, userId)));
  return row?.role ?? null;
}

// Contract.status is derived, never stored (domain-model.md).
function contractStatus(current: VersionRow): "DRAFT" | "PENDING_APPROVAL" | "LOCKED" {
  return current.status === "SUPERSEDED" ? "DRAFT" : current.status;
}

// DM-INV-10. In one place because publish, take, edit and invite must agree on what "open" means.
export function isOpenProject(contract: Pick<ContractRow, "sellerId" | "publishedUntil">, now: Date): boolean {
  return contract.sellerId === null && contract.publishedUntil !== null && contract.publishedUntil > now;
}

export function total(snapshot: ContractSnapshot): Money {
  return {
    amountMinor: snapshot.milestones.reduce((sum, m) => sum + m.amount.amountMinor, 0),
    currency: snapshot.currency,
  };
}

export async function versionView(q: Q, version: VersionRow) {
  const snapshot = version.snapshot as ContractSnapshot;
  const approvals = await q
    .select()
    .from(contractApprovals)
    .where(eq(contractApprovals.contractVersionId, version.id))
    .orderBy(contractApprovals.approvedAt);
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    snapshot,
    snapshotHash: version.snapshotHash,
    approvals: approvals.map((a) => ({
      partyRole: a.partyRole,
      userId: a.userId,
      approvedAt: a.approvedAt.toISOString(),
      snapshotHash: a.snapshotHash,
    })),
    verifiability: snapshot.milestones.map((m) => {
      const score = verifiabilityScore(m);
      return { milestoneId: m.id, score, belowThreshold: score < LOW_VERIFIABILITY };
    }),
    diff: null,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
  };
}

// Who moves each state forward, from the Actor column of milestone-state-machine.md:
// FUNDED -> SM-T04 (seller starts), IN_PROGRESS -> SM-T05 (seller submits),
// VERIFYING -> SM-T06/T07 (system), OBJECTION_WINDOW -> SM-T08/T10 (buyer approves or
// objects), OBJECTED -> SM-T11 (seller resubmits), PARTIALLY_RELEASED -> SM-T21 or T22 (seller
// fixes or accepts). Terminal states have no next step.
const STEP_BY_STATE: Partial<Record<MilestoneRow["state"], { actor: string; kind: string }>> = {
  APPROVED: { actor: "BUYER", kind: "FUND" },
  FUNDED: { actor: "SELLER", kind: "START_WORK" },
  IN_PROGRESS: { actor: "SELLER", kind: "SUBMIT" },
  VERIFYING: { actor: "SYSTEM", kind: "WAIT_FOR_VERIFICATION" },
  OBJECTION_WINDOW: { actor: "BUYER", kind: "APPROVE_OR_OBJECT" },
  OBJECTED: { actor: "SELLER", kind: "RESPOND_TO_OBJECTION" },
  PARTIALLY_RELEASED: { actor: "SELLER", kind: "FIX_OR_ACCEPT_PARTIAL" },
};

// constitution XII: every milestone answers "what happens next, and who acts?".
export function nextStep(row: Pick<MilestoneRow, "state"> & { windowEndsAt?: Date | null }, version: Pick<VersionRow, "status">, approvedRoles: ReadonlySet<string>, escalated = false) {
  // Delivering again no longer answers an escalated objection (G-NOT-ESCALATED): it is the Reviewer's.
  if (row.state === "OBJECTED" && escalated) return { actor: "REVIEWER", kind: "RULE_ON_OBJECTION", at: null };
  const byState = STEP_BY_STATE[row.state];
  // During the countdown, `at` is when silence releases what counts (SM-T09 / T19).
  if (byState !== undefined) return { ...byState, at: row.state === "OBJECTION_WINDOW" ? (row.windowEndsAt?.toISOString() ?? null) : null };
  if (row.state === "RELEASED" || row.state === "CLOSED" || row.state === "VOIDED") return { actor: "NONE", kind: "NONE", at: null };
  if (version.status === "PENDING_APPROVAL") {
    const missing = (["BUYER", "SELLER"] as const).filter((r) => !approvedRoles.has(r));
    return { actor: missing.length === 1 ? missing[0] : "NONE", kind: "APPROVE_CONTRACT_VERSION", at: null };
  }
  return { actor: "NONE", kind: "APPROVE_CONTRACT_VERSION", at: null };
}

// The transition that sent a round back, read from the audit log: the state alone cannot tell a
// countdown nobody answered from a failed check, and the screen has to say which (Milestone.returnReason).
const RETURN_REASONS: Readonly<Record<string, "WINDOW_EXPIRED" | "VERIFICATION_FAILED" | "RELEASE_DECLINED">> = {
  "milestone.transition.SM-T24": "WINDOW_EXPIRED",
  "milestone.transition.SM-T25": "WINDOW_EXPIRED",
  "milestone.transition.SM-T06": "VERIFICATION_FAILED",
  "milestone.transition.SM-T23": "VERIFICATION_FAILED",
  "milestone.transition.SM-T26": "RELEASE_DECLINED",
};

interface Runtime {
  readonly releases: readonly ReleaseRow[];
  readonly openObjectionId: string | null;
  readonly latestObjectionId: string | null;
  readonly escalated: boolean;
  readonly returnReason: "WINDOW_EXPIRED" | "VERIFICATION_FAILED" | "RELEASE_DECLINED" | null;
  readonly holds: readonly HoldRow[];
  readonly parts: readonly PartRow[];
  readonly names: ReadonlyMap<string, string>;
}

const emptyRuntime = (): Runtime => ({ releases: [], openObjectionId: null, latestObjectionId: null, escalated: false, returnReason: null, holds: [], parts: [], names: new Map() });

// Decision 6 (ADR-0009): a collaborator sees only their own hold and their own parts. null:
// buyer, seller or a system caller, who see the whole team.
type MoneyViewer = string | null;

function milestoneView(
  def: SnapshotMilestone,
  position: number,
  row: MilestoneRow,
  snapshot: ContractSnapshot,
  version: VersionRow,
  approvedRoles: ReadonlySet<string>,
  runtime: Runtime,
  onlyFor: MoneyViewer,
) {
  const money = (amountMinor: number) => ({ amountMinor, currency: def.amount.currency });
  const visible = (payeeUserId: string) => onlyFor === null || payeeUserId === onlyFor;
  const holdById = new Map(runtime.holds.map((h) => [h.id, h]));
  return {
    id: def.id,
    contractId: row.contractId,
    position,
    title: def.title,
    description: def.description,
    amount: def.amount,
    // Same rule as each release's fee; with the MVP fee of 0 bps this is always 0.
    platformFee: {
      amountMinor: platformFee(def.amount.amountMinor, snapshot.terms.platformFeeBps),
      currency: def.amount.currency,
    },
    dueDate: def.dueDate,
    criteria: def.criteria.map((c, i) => ({ ...c, position: i })),
    verifiabilityScore: verifiabilityScore(def),
    state: row.state,
    holdStatus: row.holdStatus,
    stateVersion: row.stateVersion,
    authorizationExpiresAt: row.authorizationExpiresAt?.toISOString() ?? null,
    windowEndsAt: row.windowEndsAt?.toISOString() ?? null,
    latestRunId: row.latestRunId,
    openObjectionId: runtime.openObjectionId,
    latestObjectionId: runtime.latestObjectionId,
    returnReason: row.state === "IN_PROGRESS" || row.state === "PARTIALLY_RELEASED" ? runtime.returnReason : null,
    // "Where is my money?" (constitution XII): every cent is in exactly one of these.
    funded: money(row.fundedMinor),
    released: money(row.releasedMinor),
    returned: money(row.returnedMinor),
    held: money(row.fundedMinor - row.releasedMinor - row.returnedMinor),
    releases: runtime.releases.map((r) => ({
      id: r.id,
      seq: r.seq,
      transitionId: r.transitionId,
      amount: { amountMinor: r.amountMinor, currency: r.currency },
      platformFee: { amountMinor: r.platformFeeMinor, currency: r.currency },
      countedBps: r.countedBps,
      final: r.final,
      status: r.status,
      decidedAt: r.decidedAt.toISOString(),
      parts: runtime.parts.flatMap((p) => {
        const payeeUserId = holdById.get(p.holdId)?.payeeUserId;
        if (p.releaseId !== r.id || payeeUserId === undefined || !visible(payeeUserId)) return [];
        return [{ payeeUserId, amount: money(p.amountMinor), platformFee: money(p.platformFeeMinor), status: p.status }];
      }),
    })),
    // "Where is my money?" per person (constitution XII, ADR-0009).
    holds: runtime.holds
      .filter((h) => visible(h.payeeUserId))
      .map((h) => ({
        payeeUserId: h.payeeUserId,
        payeeName: runtime.names.get(h.payeeUserId) ?? "",
        shareBps: h.shareBps,
        funded: money(h.fundedMinor),
        released: money(h.releasedMinor),
        returned: money(h.returnedMinor),
        holdStatus: h.holdStatus,
      })),
    nextStep: nextStep(row, version, approvedRoles, runtime.escalated),
  };
}

async function runtimeOf(q: Q, ids: readonly string[]): Promise<Map<string, Runtime>> {
  const byId = new Map<string, { releases: ReleaseRow[]; openObjectionId: string | null; latestObjectionId: string | null; escalated: boolean; returnReason: Runtime["returnReason"]; holds: HoldRow[]; parts: PartRow[]; names: Map<string, string> }>(
    ids.map((id) => [id, { releases: [], openObjectionId: null, latestObjectionId: null, escalated: false, returnReason: null, holds: [], parts: [], names: new Map() }]),
  );
  if (ids.length === 0) return byId;
  for (const r of await q.select().from(releases).where(inArray(releases.milestoneId, [...ids])).orderBy(asc(releases.seq))) byId.get(r.milestoneId)?.releases.push(r);
  const allHolds = await q.select().from(holds).where(inArray(holds.milestoneId, [...ids])).orderBy(asc(holds.position));
  for (const h of allHolds) byId.get(h.milestoneId)?.holds.push(h);
  if (allHolds.length > 0) {
    const milestoneOf = new Map(allHolds.map((h) => [h.id, h.milestoneId]));
    for (const p of await q.select().from(releaseParts).where(inArray(releaseParts.holdId, [...milestoneOf.keys()]))) byId.get(milestoneOf.get(p.holdId) ?? "")?.parts.push(p);
    const people = await q.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [...new Set(allHolds.map((h) => h.payeeUserId))]));
    for (const h of allHolds) {
      const name = people.find((p) => p.id === h.payeeUserId)?.name;
      if (name !== undefined) byId.get(h.milestoneId)?.names.set(h.payeeUserId, name);
    }
  }
  // Oldest first, so the last one seen is the latest.
  for (const o of await q.select({ id: objections.id, milestoneId: objections.milestoneId, status: objections.status }).from(objections).where(inArray(objections.milestoneId, [...ids])).orderBy(asc(objections.raisedAt))) {
    const entry = byId.get(o.milestoneId);
    if (entry === undefined) continue;
    entry.latestObjectionId = o.id;
    if ((LIVE_OBJECTION as readonly string[]).includes(o.status)) {
      entry.openObjectionId = o.id;
      entry.escalated = o.status === "ESCALATED";
    }
  }
  // Oldest first, so the last one seen is the latest transition of each milestone.
  for (const t of await q.select({ milestoneId: auditLog.entityId, action: auditLog.action }).from(auditLog).where(and(inArray(auditLog.entityId, [...ids]), like(auditLog.action, "milestone.transition.%"))).orderBy(asc(auditLog.at))) {
    const entry = byId.get(t.milestoneId);
    if (entry !== undefined) entry.returnReason = RETURN_REASONS[t.action] ?? null;
  }
  return byId;
}

// One milestone as the Milestone schema, from its locked version (GET /milestones/{id} and the
// responses of every transition). Who may see it is checked by the caller; `onlyFor` is a
// collaborator's id, so they see only their own money (decision 6).
export async function milestoneDetail(q: Q, row: MilestoneRow, onlyFor: MoneyViewer = null) {
  if (row.lockedVersionId === null) throw new Error(`Milestone ${row.id} is not locked`);
  const [version] = await q.select().from(contractVersions).where(eq(contractVersions.id, row.lockedVersionId));
  if (version === undefined) throw new Error(`Version ${row.lockedVersionId} not found`);
  const snapshot = version.snapshot as ContractSnapshot;
  const position = snapshot.milestones.findIndex((m) => m.id === row.id);
  const def = snapshot.milestones[position];
  if (def === undefined) throw new Error(`Milestone ${row.id} is missing from its locked version`);
  const runtime = (await runtimeOf(q, [row.id])).get(row.id) ?? emptyRuntime();
  return milestoneView(def, position, row, snapshot, version, new Set(["BUYER", "SELLER"]), runtime, onlyFor);
}

// Decision 6 (ADR-0009): a collaborator sees every member of the team but only their own share.
// The raw snapshot would show the others' shares, so its team is redacted the same way.
function redactTeam(snapshot: ContractSnapshot, viewerId: string): ContractSnapshot {
  return { ...snapshot, team: teamOf(snapshot).map((t) => (t.userId === viewerId ? t : { ...t, shareBps: null as unknown as number })) };
}

async function teamView(q: Q, snapshot: ContractSnapshot, contract: ContractRow, approvedUserIds: ReadonlySet<string>, viewerId: string, myRole: PartyRole) {
  const team = teamOf(snapshot);
  const ids = team.map((t) => t.userId ?? contract.sellerId).filter((id): id is string => id !== null);
  const people = ids.length === 0 ? [] : await q.select({ id: users.id, name: users.displayName, headline: users.headline, professions: users.professions }).from(users).where(inArray(users.id, ids));
  const byId = new Map(people.map((p) => [p.id, p]));
  return team.map((t) => {
    const userId = t.userId ?? contract.sellerId;
    const person = userId === null ? undefined : byId.get(userId);
    return {
      userId,
      displayName: person?.name ?? "Seller (not joined yet)",
      headline: person?.headline ?? null,
      professions: person?.professions ?? [],
      role: t.role,
      shareBps: myRole === "COLLABORATOR" && userId !== viewerId ? null : t.shareBps,
      isSeller: t.userId === null,
      approvedCurrentVersion: userId !== null && approvedUserIds.has(userId),
    };
  });
}

export async function contractView(q: Q, contract: ContractRow, viewerId: string) {
  const myRole = await partyRoleIn(q, contract, viewerId);
  if (myRole === null || contract.currentVersionId === null) throw new Error("contractView: caller is not a party");

  const [current] = await q.select().from(contractVersions).where(eq(contractVersions.id, contract.currentVersionId));
  if (current === undefined) throw new Error(`Contract ${contract.id} has no current version`);
  const snapshot = current.snapshot as ContractSnapshot;
  const fullVersion = await versionView(q, current);
  const currentVersion = myRole === "COLLABORATOR" ? { ...fullVersion, snapshot: redactTeam(snapshot, viewerId) } : fullVersion;
  const approvedRoles = new Set(currentVersion.approvals.map((a) => a.partyRole));

  const ids = snapshot.milestones.map((m) => m.id);
  const rows = ids.length === 0 ? [] : await q.select().from(milestones).where(inArray(milestones.id, ids));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const runtimes = await runtimeOf(q, ids);

  const lockedNumber =
    contract.lockedVersionId === null
      ? null
      : ((await q.select({ v: contractVersions.version }).from(contractVersions).where(eq(contractVersions.id, contract.lockedVersionId)))[0]?.v ??
        null);

  // A collaborator's counterparty is the buyer, like the seller's.
  const counterpartyId = myRole === "BUYER" ? contract.sellerId : contract.buyerId;
  const counterpartyName =
    counterpartyId === null
      ? null
      : ((await q.select({ name: users.displayName }).from(users).where(eq(users.id, counterpartyId)))[0]?.name ?? null);

  // Only the buyer sees whom they invited (openapi 0.17.0), and only while there is no seller.
  // Ordered by expiry, not creation: a renewed invitation keeps its row and gets a new expiry, so
  // the one with the latest expiry is the one sent last.
  const [pendingInvitation = null] =
    myRole === "BUYER" && contract.sellerId === null
      ? await q
          .select({ email: invitations.email, expiresAt: invitations.expiresAt })
          .from(invitations)
          .where(and(eq(invitations.contractId, contract.id), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
          .orderBy(desc(invitations.expiresAt))
          .limit(1)
      : [];

  const [{ last } = { last: null }] = await q.select({ last: max(auditLog.at) }).from(auditLog).where(eq(auditLog.contractId, contract.id));
  // History without audit rows still has its releases; a new contract has its creation.
  const releasedAt = [...runtimes.values()].flatMap((r) => r.releases.map((x) => x.decidedAt.getTime()));
  const lastActivityAt = new Date(Math.max(contract.createdAt.getTime(), last?.getTime() ?? 0, ...releasedAt)).toISOString();

  return {
    id: contract.id,
    lastActivityAt,
    title: snapshot.title,
    status: contractStatus(current),
    total: total(snapshot),
    myRole,
    counterpartyName,
    buyerId: contract.buyerId,
    sellerId: contract.sellerId,
    publishedUntil: contract.sellerId === null ? contract.publishedUntil : null,
    pendingInvitation: pendingInvitation === null ? null : { email: pendingInvitation.email, expiresAt: pendingInvitation.expiresAt.toISOString() },
    currentVersion,
    lockedVersionNumber: lockedNumber,
    team: await teamView(q, snapshot, contract, new Set(fullVersion.approvals.filter((a) => a.snapshotHash === current.snapshotHash).map((a) => a.userId)), viewerId, myRole),
    milestones: snapshot.milestones.map((def, i) => {
      const row = rowById.get(def.id);
      if (row === undefined) throw new Error(`Milestone ${def.id} has no runtime row`);
      return milestoneView(def, i, row, snapshot, current, approvedRoles, runtimes.get(def.id) ?? emptyRuntime(), myRole === "COLLABORATOR" ? viewerId : null);
    }),
  };
}

export async function contractSummaries(q: Q, viewerId: string, rows: ContractRow[]) {
  const summaries = [];
  for (const c of rows) {
    const view = await contractView(q, c, viewerId);
    summaries.push({
      id: view.id,
      title: view.title,
      status: view.status,
      total: view.total,
      myRole: view.myRole,
      counterpartyName: view.counterpartyName,
    });
  }
  return summaries;
}

export async function findVersion(q: Q, contractId: string, version: number) {
  const [row] = await q
    .select()
    .from(contractVersions)
    .where(and(eq(contractVersions.contractId, contractId), eq(contractVersions.version, version)));
  return row;
}
