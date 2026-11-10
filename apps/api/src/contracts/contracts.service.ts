// 001 minimum (H1, ADR-0004): create, edit, submit and approve a contract.
//
// The one rule every write here follows: open a transaction, lock the contract row with
// SELECT ... FOR UPDATE, then read and decide. The contract is the aggregate root, so one
// lock covers its versions, approvals, invitations and milestones. With a single lock per
// aggregate there is no lock ordering to get wrong, and therefore no deadlock between
// two writes on the same contract.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { Actor } from "../audit/actor.js";
import { recordAudit } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { APP_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import { contractApprovals, contractParties, contracts, contractVersions, milestones, users } from "../db/schema.js";
import type { PartyRole } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { notFound } from "../http/params.js";
import { enqueueEvent } from "../outbox/outbox.js";
import { JOB_SCHEDULER } from "../payments/job-scheduler.js";
import type { JobScheduler } from "../payments/job-scheduler.js";
import { contractSummaries, contractView, findVersion, isOpenProject, partyRoleIn, versionView } from "./contract-view.js";
import type { ParsedDraft } from "./draft-input.js";
import { buildSnapshot, hashSnapshot, LOW_VERIFIABILITY, milestoneGuardFailures, teamOf, verifiabilityScore } from "./snapshot.js";
import type { ContractSnapshot } from "./snapshot.js";

export interface Caller {
  readonly user: AuthenticatedUser;
  readonly requestId: string;
}

const userActor = (c: Caller): Actor => ({ type: "USER", id: c.user.id });
// SM-T01 runs as SYSTEM: no person moves the milestone, the lock does (milestone-state-machine.md).
const LOCK_ACTOR: Actor = { type: "SYSTEM", id: "contracts.version.lock" };

const PAGE_SIZE = 20;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

@Injectable()
export class ContractsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JOB_SCHEDULER) private readonly jobs: JobScheduler,
  ) {}

  // ---------------------------------------------------------------- locking

  // The heart of ADR-0004. FOR UPDATE makes every other transaction that wants this row
  // wait until we commit or roll back. Reads after this line see the latest committed
  // state, and nobody can change it under us until we finish.
  async lockContract(tx: Tx, contractId: string, caller: Caller) {
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).for("update");
    // Same answer for "missing" and "not yours": NOT_FOUND never reveals existence (errors.md).
    if (contract === undefined) throw notFound();
    const role = await partyRoleIn(tx, contract, caller.user.id);
    if (role === null) throw notFound();
    return { contract, role };
  }

  private async currentVersion(tx: Tx, versionId: string | null) {
    if (versionId === null) throw new Error("Contract without a current version");
    const [v] = await tx.select().from(contractVersions).where(eq(contractVersions.id, versionId));
    if (v === undefined) throw new Error(`Version ${versionId} not found`);
    return v;
  }

  // ---------------------------------------------------------------- create

  async create(tx: Tx, caller: Caller, input: ParsedDraft) {
    // openapi: "Caller becomes the buyer".
    if (!caller.user.roles.includes("BUYER")) {
      throw new ProblemException("FORBIDDEN", 403, "Only buyers can create contracts", "Your account has no BUYER role.");
    }
    const snapshot = buildSnapshot(input, {
      platformFeeBps: this.config.platformFeeBps,
      newId: randomUUID,
      knownMilestoneIds: new Set(),
      knownCriterionIds: new Set(),
    });
    // A new contract has no collaborators yet: the seller adds them once they join.
    this.assertTeamMembers(snapshot, new Set());

    const [contract] = await tx.insert(contracts).values({ buyerId: caller.user.id }).returning();
    if (contract === undefined) throw new Error("insert returned nothing");
    const [version] = await tx
      .insert(contractVersions)
      .values({ contractId: contract.id, version: 1, status: "DRAFT", snapshot, createdBy: userActor(caller) })
      .returning();
    if (version === undefined) throw new Error("insert returned nothing");
    const [updated] = await tx
      .update(contracts)
      .set({ currentVersionId: version.id })
      .where(eq(contracts.id, contract.id))
      .returning();
    if (updated === undefined) throw new Error("update returned nothing");
    await this.syncMilestoneRows(tx, contract.id, snapshot);

    await recordAudit(tx, {
      actor: userActor(caller),
      action: "contract.created",
      entityType: "Contract",
      entityId: contract.id,
      contractId: contract.id,
      after: { version: 1 },
      requestId: caller.requestId,
    });
    await enqueueEvent(tx, {
      type: "contracts.contract.created",
      actor: userActor(caller),
      contractId: contract.id,
      correlationId: caller.requestId,
      payload: { title: snapshot.title, buyerId: caller.user.id },
    });
    return contractView(tx, updated, caller.user.id);
  }

  // ---------------------------------------------------------------- reads

  async get(contractId: string, caller: Caller) {
    const [contract] = await this.db.select().from(contracts).where(eq(contracts.id, contractId));
    if (contract === undefined || (await partyRoleIn(this.db, contract, caller.user.id)) === null) throw notFound();
    return contractView(this.db, contract, caller.user.id);
  }

  async list(caller: Caller, role: PartyRole | undefined, cursor: string | undefined) {
    const me = caller.user.id;
    const asCollaborator = inArray(contracts.id, this.db.select({ id: contractParties.contractId }).from(contractParties).where(eq(contractParties.userId, me)));
    const party =
      role === "BUYER"
        ? eq(contracts.buyerId, me)
        : role === "SELLER"
          ? eq(contracts.sellerId, me)
          : role === "COLLABORATOR"
            ? asCollaborator
            : or(eq(contracts.buyerId, me), eq(contracts.sellerId, me), asCollaborator);
    // Keyset pagination on the UUIDv7 id (time-ordered): stable under inserts, unlike OFFSET.
    const rows = await this.db
      .select()
      .from(contracts)
      .where(cursor === undefined ? party : and(party, lt(contracts.id, cursor)))
      .orderBy(desc(contracts.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: await contractSummaries(this.db, me, page),
      nextCursor: rows.length > PAGE_SIZE && last !== undefined ? last.id : null,
    };
  }

  // ---------------------------------------------------------------- replaceDraft

  async replaceDraft(tx: Tx, caller: Caller, contractId: string, ifMatch: string | undefined, input: ParsedDraft) {
    const { contract, role } = await this.lockContract(tx, contractId, caller);
    this.forbidCollaborator(role, "edit the draft");
    // DM-INV-10: a seller takes exactly what is listed. The hash would catch a change, but only by
    // refusing the seller after they read terms that no longer exist.
    if (isOpenProject(contract, new Date())) {
      throw new ProblemException("INVALID_TRANSITION", 409, "This project is open", "Withdraw it first, then edit it.");
    }
    const current = await this.currentVersion(tx, contract.currentVersionId);

    // If-Match carries the version number the caller edited. Without it, two people editing
    // the same draft would silently overwrite each other (lost update).
    if (ifMatch === undefined || ifMatch !== String(current.version)) {
      throw new ProblemException("STALE_STATE", 409, "This contract changed since you opened it", "Reload to see the latest version, then edit again.", {
        currentVersion: current.version,
      });
    }
    if (current.status === "LOCKED") {
      throw new ProblemException("INVALID_TRANSITION", 409, "This version is already agreed", "Locked versions cannot be edited. Use amend to start a new version.");
    }

    const previous = current.snapshot as ContractSnapshot;
    const snapshot = buildSnapshot(input, {
      platformFeeBps: this.config.platformFeeBps,
      newId: randomUUID,
      knownMilestoneIds: new Set(previous.milestones.map((m) => m.id)),
      knownCriterionIds: new Set(previous.milestones.flatMap((m) => m.criteria.map((c) => c.id))),
    });
    this.assertTeamMembers(snapshot, await this.collaboratorIds(tx, contractId));

    let version: typeof current;
    if (current.status === "DRAFT") {
      // A draft has no hash yet, so nobody has approved it: editing in place is safe.
      const [updated] = await tx.update(contractVersions).set({ snapshot }).where(eq(contractVersions.id, current.id)).returning();
      if (updated === undefined) throw new Error("update returned nothing");
      version = updated;
    } else {
      // PENDING_APPROVAL is frozen (ADR-0004, H1-G3): it becomes SUPERSEDED and the edit is
      // version N+1. Its approvals stay attached to N, so they no longer count for anything.
      await tx.update(contractVersions).set({ status: "SUPERSEDED" }).where(eq(contractVersions.id, current.id));
      const [created] = await tx
        .insert(contractVersions)
        .values({
          contractId,
          version: current.version + 1,
          status: "DRAFT",
          snapshot,
          parentVersionId: current.id,
          createdBy: userActor(caller),
        })
        .returning();
      if (created === undefined) throw new Error("insert returned nothing");
      await tx.update(contracts).set({ currentVersionId: created.id, updatedAt: new Date() }).where(eq(contracts.id, contractId));
      version = created;
    }
    await this.syncMilestoneRows(tx, contractId, snapshot);
    await recordAudit(tx, {
      actor: userActor(caller),
      action: "contract.draft.replaced",
      entityType: "ContractVersion",
      entityId: version.id,
      contractId,
      before: { version: current.version, status: current.status },
      after: { version: version.version, status: version.status },
      requestId: caller.requestId,
    });
    return versionView(tx, version);
  }

  // Milestone runtime rows mirror the current draft: one row per milestone, all in DRAFT
  // until SM-T01. Only DRAFT rows are ever deleted; anything past DRAFT is owned by 002.
  private async syncMilestoneRows(tx: Tx, contractId: string, snapshot: ContractSnapshot) {
    const ids = snapshot.milestones.map((m) => m.id);
    await tx
      .delete(milestones)
      .where(and(eq(milestones.contractId, contractId), eq(milestones.state, "DRAFT"), ids.length > 0 ? notInArray(milestones.id, ids) : undefined));
    if (ids.length > 0) {
      await tx
        .insert(milestones)
        .values(ids.map((id) => ({ id, contractId })))
        .onConflictDoNothing();
    }
  }

  // ---------------------------------------------------------------- submit

  async submit(tx: Tx, caller: Caller, contractId: string) {
    const { contract, role } = await this.lockContract(tx, contractId, caller);
    this.forbidCollaborator(role, "send the contract for approval");
    const current = await this.currentVersion(tx, contract.currentVersionId);
    if (current.status !== "DRAFT") {
      throw new ProblemException("INVALID_TRANSITION", 409, "This version was already submitted", `The current version is ${current.status}.`, {
        version: current.version,
        status: current.status,
      });
    }
    const snapshot = current.snapshot as ContractSnapshot;
    // Check G-MILESTONE-VALID now, so nobody approves something that can never lock.
    // It is checked again at lock time: a due date can pass while approvals wait.
    this.assertMilestonesValid(snapshot);

    const snapshotHash = hashSnapshot(snapshot);
    const [submitted] = await tx
      .update(contractVersions)
      .set({ status: "PENDING_APPROVAL", snapshotHash })
      .where(eq(contractVersions.id, current.id))
      .returning();
    if (submitted === undefined) throw new Error("update returned nothing");

    await recordAudit(tx, {
      actor: userActor(caller),
      action: "contract.version.submitted",
      entityType: "ContractVersion",
      entityId: current.id,
      contractId,
      after: { version: current.version, snapshotHash },
      requestId: caller.requestId,
    });
    await enqueueEvent(tx, {
      type: "contracts.version.submitted",
      actor: userActor(caller),
      contractId,
      correlationId: caller.requestId,
      payload: { versionId: current.id, version: current.version, snapshotHash, submittedByRole: role },
    });
    return versionView(tx, submitted);
  }

  private forbidCollaborator(role: PartyRole, what: string) {
    if (role === "COLLABORATOR") throw new ProblemException("FORBIDDEN", 403, "Collaborators review and approve", `Only the buyer or the seller can ${what}.`);
  }

  private async collaboratorIds(tx: Tx, contractId: string): Promise<Set<string>> {
    const rows = await tx.select({ id: contractParties.userId }).from(contractParties).where(eq(contractParties.contractId, contractId));
    return new Set(rows.map((r) => r.id));
  }

  // The team may name only people the seller added to the contract: being a party is what lets
  // them see the version and approve it.
  private assertTeamMembers(snapshot: ContractSnapshot, parties: ReadonlySet<string>) {
    const strangers = teamOf(snapshot).filter((t) => t.userId !== null && !parties.has(t.userId));
    if (strangers.length > 0) {
      throw new ProblemException("VALIDATION_FAILED", 422, "Some fields need fixing", "Add these people to the contract before putting them in the team.", {
        issues: strangers.map((t) => ({ path: "team", message: `${t.userId ?? ""} is not a collaborator on this contract` })),
      });
    }
  }

  // ---------------------------------------------------------------- team (ADR-0009)

  async addTeamMember(tx: Tx, caller: Caller, contractId: string, userId: string) {
    const { contract, role } = await this.lockContract(tx, contractId, caller);
    if (role !== "SELLER") throw new ProblemException("FORBIDDEN", 403, "Only the seller builds the team", "Ask the seller of this contract to add collaborators.");
    const [person] = await tx.select().from(users).where(eq(users.id, userId));
    const invalid = (message: string) => new ProblemException("VALIDATION_FAILED", 422, "Some fields need fixing", message, { issues: [{ path: "userId", message }] });
    if (person === undefined || person.onboardingCompletedAt === null) throw invalid("Not a Settld user who finished onboarding.");
    if (userId === contract.buyerId || userId === contract.sellerId) throw invalid("The buyer and the seller cannot also be collaborators.");
    if (!person.roles.some((r) => r === "COLLABORATOR" || r === "SELLER")) throw invalid("This person does not work on teams.");
    // PayPal refuses to authorize for a payee who did not consent (PAYEE_NOT_CONSENTED).
    if (person.paypalMerchantId === null || !person.paypalPaymentsReceivable) {
      throw new ProblemException("PAYPAL_NOT_CONNECTED", 409, "This person cannot be paid yet", "They have to connect PayPal to receive payments first.");
    }
    const current = await this.collaboratorIds(tx, contractId);
    if (!current.has(userId)) {
      // Decision 4: at most 5 team members, the seller included.
      if (current.size >= 4) throw invalid("A team has at most 5 people, the seller included.");
      await tx.insert(contractParties).values({ contractId, userId, invitedBy: caller.user.id });
      await recordAudit(tx, { actor: userActor(caller), action: "contract.team.member_added", entityType: "Contract", entityId: contractId, contractId, after: { userId }, requestId: caller.requestId });
    }
    return contractView(tx, contract, caller.user.id);
  }

  assertMilestonesValid(snapshot: ContractSnapshot) {
    if (snapshot.milestones.length === 0) {
      throw new ProblemException("GUARD_FAILED", 409, "Add at least one milestone", "A contract needs at least one milestone.", {
        guard: "G-MILESTONE-VALID",
      });
    }
    const failures = milestoneGuardFailures(snapshot, today());
    if (failures.length > 0) {
      throw new ProblemException("GUARD_FAILED", 409, "Some milestones are not ready", failures.map((f) => f.reason).join(". "), {
        guard: "G-MILESTONE-VALID",
        milestones: failures,
      });
    }
  }

  // ---------------------------------------------------------------- approve

  async approve(tx: Tx, caller: Caller, contractId: string, versionNumber: number, snapshotHash: string, acknowledgeLow: boolean) {
    // Two parties approving at the same moment both arrive here. The second one waits on
    // this line until the first commits, then reads the first one's approval below.
    // Without the lock, each would see only its own approval and nobody would lock the
    // version: it would stay PENDING_APPROVAL forever.
    const { contract, role } = await this.lockContract(tx, contractId, caller);
    const version = await findVersion(tx, contractId, versionNumber);
    if (version === undefined) throw notFound();
    // A collaborator approves only a version whose team names them: their share is in it.
    if (role === "COLLABORATOR" && !teamOf(version.snapshot as ContractSnapshot).some((t) => t.userId === caller.user.id)) {
      throw new ProblemException("FORBIDDEN", 403, "You are not in this version's team", "Ask the seller to add you to the team before approving.");
    }

    if (version.status === "SUPERSEDED" || version.id !== contract.currentVersionId) {
      throw new ProblemException("STALE_STATE", 409, "There is a newer version", "This version was replaced. Review the latest version and approve that one.", {
        currentVersionId: contract.currentVersionId,
      });
    }
    // Comparing hashes, not version numbers: the hash is what the person actually saw.
    if (version.snapshotHash === null || version.snapshotHash !== snapshotHash) {
      throw new ProblemException("VERSION_HASH_MISMATCH", 409, "The contract changed", "What you approved is not the current content of this version. Reload and review it again.", {
        expected: version.snapshotHash,
      });
    }
    const snapshot = version.snapshot as ContractSnapshot;
    const low = snapshot.milestones.filter((m) => verifiabilityScore(m) < LOW_VERIFIABILITY);
    if (low.length > 0 && !acknowledgeLow) {
      throw new ProblemException("VALIDATION_FAILED", 422, "Some milestones are hard to verify", "Confirm that you accept milestones that depend mostly on human review.", {
        issues: [{ path: "acknowledgeLowVerifiability", message: "Required when a milestone scores below 0.6" }],
        milestoneIds: low.map((m) => m.id),
      });
    }

    // Approving twice is a no-op, not an error: the unique (version, role) constraint is the
    // second line of defense if the lock were ever bypassed.
    const inserted = await tx
      .insert(contractApprovals)
      .values({ contractVersionId: version.id, snapshotHash, partyRole: role, userId: caller.user.id })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      await recordAudit(tx, {
        actor: userActor(caller),
        action: "contract.version.approved",
        entityType: "ContractVersion",
        entityId: version.id,
        contractId,
        after: { partyRole: role, snapshotHash },
        requestId: caller.requestId,
      });
      await enqueueEvent(tx, {
        type: "contracts.version.approved",
        actor: userActor(caller),
        contractId,
        correlationId: caller.requestId,
        payload: { versionId: version.id, version: version.version, snapshotHash, partyRole: role },
      });
    }

    // ADR-0009, decision 2: the buyer, the seller and every collaborator in the version's team
    // approve the same hash. Nobody is paid, or not paid, by terms they did not approve.
    const approvals = await tx.select().from(contractApprovals).where(eq(contractApprovals.contractVersionId, version.id));
    const matching = approvals.filter((a) => a.snapshotHash === version.snapshotHash);
    const roles = new Set(matching.map((a) => a.partyRole));
    const approvedUsers = new Set(matching.map((a) => a.userId));
    const collaborators = teamOf(snapshot).flatMap((t) => (t.userId === null ? [] : [t.userId]));
    if (version.status === "PENDING_APPROVAL" && roles.has("BUYER") && roles.has("SELLER") && collaborators.every((id) => approvedUsers.has(id))) {
      const locked = await this.lockVersion(tx, caller, contractId, version.id, version.version, snapshotHash, snapshot);
      return versionView(tx, locked);
    }
    const [fresh] = await tx.select().from(contractVersions).where(eq(contractVersions.id, version.id));
    if (fresh === undefined) throw new Error("version vanished");
    return versionView(tx, fresh);
  }

  // G-LOCKED holds: lock the version and run SM-T01 for each milestone, all in the
  // transaction of the second approval.
  private async lockVersion(
    tx: Tx,
    caller: Caller,
    contractId: string,
    versionId: string,
    versionNumber: number,
    snapshotHash: string,
    snapshot: ContractSnapshot,
  ) {
    // G-MILESTONE-VALID again: the due date may have passed since submit. Throwing here
    // rolls back the whole transaction, including the approval that triggered the lock.
    this.assertMilestonesValid(snapshot);

    const [locked] = await tx.update(contractVersions).set({ status: "LOCKED" }).where(eq(contractVersions.id, versionId)).returning();
    if (locked === undefined) throw new Error("update returned nothing");
    await tx.update(contracts).set({ lockedVersionId: versionId, updatedAt: new Date() }).where(eq(contracts.id, contractId));

    const ids = snapshot.milestones.map((m) => m.id);
    // SM-T01 DRAFT -> APPROVED. The `state = 'DRAFT'` condition makes the transition
    // conditional on the state we expect; if any milestone was not in DRAFT, the row count
    // is short and we refuse instead of silently skipping it.
    const moved = await tx
      .update(milestones)
      .set({ state: "APPROVED", lockedVersionId: versionId, stateVersion: sql`${milestones.stateVersion} + 1` })
      .where(and(inArray(milestones.id, ids), eq(milestones.contractId, contractId), eq(milestones.state, "DRAFT")))
      .returning({ id: milestones.id, stateVersion: milestones.stateVersion });
    if (moved.length !== ids.length) {
      throw new ProblemException("INVALID_TRANSITION", 409, "Some milestones cannot be approved", "Not every milestone was in DRAFT.", {
        transitionId: "SM-T01",
      });
    }

    for (const m of moved) {
      await recordAudit(tx, {
        actor: LOCK_ACTOR,
        action: "milestone.transition.SM-T01",
        entityType: "Milestone",
        entityId: m.id,
        contractId,
        before: { state: "DRAFT" },
        after: { state: "APPROVED", stateVersion: m.stateVersion },
        requestId: caller.requestId,
      });
      await enqueueEvent(tx, {
        type: "payments.milestone.state_changed",
        actor: LOCK_ACTOR,
        contractId,
        milestoneId: m.id,
        correlationId: caller.requestId,
        payload: { transitionId: "SM-T01", from: "DRAFT", to: "APPROVED", event: "CONTRACT_VERSION_LOCKED", stateVersion: m.stateVersion },
      });
    }
    await enqueueEvent(tx, {
      type: "contracts.version.locked",
      actor: LOCK_ACTOR,
      contractId,
      correlationId: caller.requestId,
      payload: { versionId, version: versionNumber, snapshotHash, milestoneIds: ids },
    });
    // Here and not in take(): every path to LOCKED must warn the same people, or an invited contract
    // and an open project would drift apart. In this transaction (constitution IV): a take that rolls
    // back leaves no mail announcing an agreement that never happened.
    const [parties] = await tx.select({ buyerId: contracts.buyerId, sellerId: contracts.sellerId }).from(contracts).where(eq(contracts.id, contractId));
    if (parties?.sellerId == null) throw new Error(`Contract ${contractId} locked without a seller`);
    await this.jobs.send(tx, {
      queue: "notifications.send",
      singletonKey: `notify:contract.locked:${versionId}`,
      data: { templateKey: "contract.locked", recipientIds: [parties.buyerId, parties.sellerId], deepLink: `/contracts/${contractId}`, params: { contractId, versionId } },
    });
    return locked;
  }
}
