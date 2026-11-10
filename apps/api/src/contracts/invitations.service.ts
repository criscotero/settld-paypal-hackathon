// inviteSeller, acceptInvitation, listMyInvitations and acceptMyInvitation (openapi.yaml 0.8.0;
// Invitation in domain-model.md 0.7.0).
import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { recordAudit } from "../audit/audit.js";
import { APP_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import { auditLog, contracts, contractVersions, invitations, users } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { notFound } from "../http/params.js";
import { enqueueEvent } from "../outbox/outbox.js";
import { JOB_SCHEDULER } from "../payments/job-scheduler.js";
import type { JobScheduler } from "../payments/job-scheduler.js";
import { isOpenProject, contractView } from "./contract-view.js";
import type { ContractSnapshot } from "./snapshot.js";
import { ContractsService } from "./contracts.service.js";
import type { Caller } from "./contracts.service.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Each invitation is a mail from Settld to an address someone typed (ADR-0013). Far above what a
// person needs, low enough that an account is not worth abusing to send mail to strangers.
export const MAX_INVITATIONS_PER_DAY = 20;

// Port for the link with a token, for an invitation forwarded to another address: development
// logs it, and tests capture it. The mail does NOT use it: it goes through a job, which lives in
// the database, and the token must not (only its hash is stored). ADR-0013.
export interface InvitationSender {
  send(email: string, token: string, contractId: string): void;
}
export const INVITATION_SENDER = Symbol("INVITATION_SENDER");

@Injectable()
export class LoggingInvitationSender implements InvitationSender {
  private readonly logger = new Logger("Invitations");
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  send(email: string, token: string, contractId: string): void {
    this.logger.log(`Invitation for ${email} to contract ${contractId}: ${this.config.webUrl}/invitations/${token}`);
  }
}

// PendingInvitation (openapi.yaml): what the seller sees in the list.
function summary({ invitation, snapshot, buyerName }: { invitation: typeof invitations.$inferSelect; snapshot: unknown; buyerName: string }) {
  const s = snapshot as ContractSnapshot;
  return {
    id: invitation.id,
    contractId: invitation.contractId,
    contractTitle: s.title,
    buyerName,
    total: { amountMinor: s.milestones.reduce((sum, m) => sum + m.amount.amountMinor, 0), currency: s.currency },
    invitedAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

export function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly contractsService: ContractsService,
    @Inject(INVITATION_SENDER) private readonly sender: InvitationSender,
    @Inject(JOB_SCHEDULER) private readonly jobs: JobScheduler,
  ) {}

  async invite(tx: Tx, caller: Caller, contractId: string, email: string) {
    const { contract, role } = await this.contractsService.lockContract(tx, contractId, caller);
    if (role !== "BUYER") {
      throw new ProblemException("FORBIDDEN", 403, "Only the buyer can invite", "Ask the buyer of this contract to send the invitation.");
    }
    if (contract.sellerId !== null) {
      throw new ProblemException("INVALID_TRANSITION", 409, "This contract already has a seller", "A contract has exactly one seller.");
    }

    // DM-INV-10: an invited seller and a stranger must not compete for the same contract.
    if (isOpenProject(contract, new Date())) {
      throw new ProblemException("INVALID_TRANSITION", 409, "This project is open", "Withdraw it first, then invite a seller.");
    }

    // Counts sends, not rows: a renewed invitation keeps its row, so counting rows would let one
    // address be mailed without limit. Every send writes this audit entry, first or repeated.
    const since = new Date(Date.now() - DAY_MS);
    const [{ sent } = { sent: 0 }] = await tx
      .select({ sent: count() })
      .from(auditLog)
      .innerJoin(contracts, eq(contracts.id, auditLog.contractId))
      .where(and(eq(contracts.buyerId, caller.user.id), eq(auditLog.action, "contract.invitation.sent"), gt(auditLog.at, since)));
    if (sent >= MAX_INVITATIONS_PER_DAY) {
      throw new ProblemException("RATE_LIMITED", 429, "Too many invitations today", `You can send ${String(MAX_INVITATIONS_PER_DAY)} invitations in 24 hours. Try again tomorrow.`, { retryAfterSeconds: DAY_MS / 1000 });
    }

    // 32 random bytes: unguessable. Only its hash is stored, so a database leak (or a
    // backup, or a log of SQL) does not hand out working invitation links.
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    // One pending invitation per contract and address (domain-model 0.11.0). A buyer who is not
    // sure the first one went out invites again; a second row would show the invitee the same
    // contract twice (live test 2026-11-07: three rows for one seller). Renewing gives a fresh
    // token too, so the newest link is the one that works. No race: lockContract above holds
    // this contract's row, so two invites to it run one after the other.
    const [pending] = await tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.contractId, contractId), sql`lower(${invitations.email}) = lower(${email})`, isNull(invitations.acceptedAt), gt(invitations.expiresAt, now)))
      .orderBy(desc(invitations.createdAt))
      .limit(1);
    const [invitation] =
      pending === undefined
        ? await tx.insert(invitations).values({ contractId, email, tokenHash: hashToken(token), expiresAt }).returning()
        : await tx.update(invitations).set({ tokenHash: hashToken(token), expiresAt }).where(eq(invitations.id, pending.id)).returning();
    if (invitation === undefined) throw new Error("insert returned nothing");

    await recordAudit(tx, {
      actor: { type: "USER", id: caller.user.id },
      action: "contract.invitation.sent",
      entityType: "Invitation",
      entityId: invitation.id,
      contractId,
      after: { email, resent: pending !== undefined },
      requestId: caller.requestId,
    });
    await enqueueEvent(tx, {
      type: "contracts.contract.invitation_sent",
      actor: { type: "USER", id: caller.user.id },
      contractId,
      correlationId: caller.requestId,
      payload: { inviteeEmail: email },
    });
    // In this transaction (constitution IV): if the invitation commits, the mail will go out.
    await this.jobs.send(tx, {
      queue: "notifications.send",
      // round: the same invitation mailed again is a different mail (notifications.service).
      singletonKey: `notify:invitation.sent:${invitation.id}:${now.toISOString()}`,
      data: { templateKey: "invitation.sent", recipientIds: [], recipientEmail: email, deepLink: "/invitations", params: { invitationId: invitation.id, round: now.toISOString() } },
    });
    // Known gap: this runs before commit. If the transaction then rolls back, a logged link points
    // at an invitation that does not exist (accepting it returns 404, so nothing breaks).
    this.sender.send(email, token, contractId);
  }

  // The link: whoever holds the token. It may be forwarded to another address on purpose.
  async accept(caller: Caller, token: string) {
    return this.db.transaction((tx) => this.acceptWhere(tx, caller, eq(invitations.tokenHash, hashToken(token))));
  }

  // The seller's own list: the invitation must have been sent to the caller's email, which Clerk
  // verified before any session existed (ADR-0006). Someone else's invitation is NOT_FOUND, not
  // FORBIDDEN, so walking ids tells nothing about which ones exist.
  async acceptMine(caller: Caller, invitationId: string) {
    return this.db.transaction((tx) => this.acceptWhere(tx, caller, and(eq(invitations.id, invitationId), this.sentTo(caller.user.id))));
  }

  async listMine(userId: string) {
    const rows = await this.pendingFor(userId);
    return { items: rows.map((r) => summary(r)) };
  }

  // getMyInvitation: what the seller agrees to, read before agreeing. The current version and
  // not a frozen copy: the buyer may still edit the draft, and accepting binds the seller to
  // nothing until both approve a locked version. The team is left out; the seller builds it.
  async previewMine(userId: string, invitationId: string) {
    const [row] = await this.pendingFor(userId, eq(invitations.id, invitationId));
    if (row === undefined) throw notFound();
    const s = row.snapshot as ContractSnapshot;
    return { ...summary(row), description: s.description, terms: s.terms, milestones: s.milestones };
  }

  // The pending invitations sent to this user, with the same filters accept applies, so the
  // list and the preview never offer one that accepting would refuse.
  private pendingFor(userId: string, extra?: SQL) {
    return this.db
      .select({ invitation: invitations, snapshot: contractVersions.snapshot, buyerName: users.displayName })
      .from(invitations)
      .innerJoin(contracts, eq(contracts.id, invitations.contractId))
      .innerJoin(contractVersions, eq(contractVersions.id, contracts.currentVersionId))
      .innerJoin(users, eq(users.id, contracts.buyerId))
      .where(and(this.sentTo(userId), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date()), isNull(contracts.sellerId), extra))
      .orderBy(desc(invitations.createdAt));
  }

  // The buyer typed the address; Clerk lowercases it on our side (clerk-identity-provider).
  private sentTo(userId: string): SQL {
    return sql`lower(${invitations.email}) = (select ${users.email} from ${users} where ${users.id} = ${userId})`;
  }

  private async acceptWhere(tx: Tx, caller: Caller, which: SQL | undefined) {
    // Find the contract first, then lock it, then re-read the invitation under the lock:
    // two concurrent accepts of the same invitation must not both become the seller.
    const [found] = await tx.select({ contractId: invitations.contractId }).from(invitations).where(which);
    if (found === undefined) throw notFound();
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, found.contractId)).for("update");
    const [invitation] = await tx.select().from(invitations).where(which);
    if (contract === undefined || invitation === undefined) throw notFound();

    // Accepting again after success is a no-op (neither accept route has an Idempotency-Key).
    if (invitation.acceptedBy === caller.user.id && contract.sellerId === caller.user.id) {
      return contractView(tx, contract, caller.user.id);
    }
    if (invitation.acceptedAt !== null || contract.sellerId !== null) {
      throw new ProblemException("INVALID_TRANSITION", 409, "This invitation was already used", "Ask the buyer for a new invitation.");
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new ProblemException("INVALID_TRANSITION", 409, "This invitation expired", "Ask the buyer for a new invitation.");
    }
    if (contract.buyerId === caller.user.id) {
      throw new ProblemException("FORBIDDEN", 403, "You are the buyer of this contract", "The seller must be a different person.");
    }
    if (!caller.user.roles.includes("SELLER")) {
      throw new ProblemException("FORBIDDEN", 403, "Only sellers can accept", "Your account has no SELLER role.");
    }
    // ADR-0004, H1-G2: the seller must be able to receive the money before agreeing.
    const [me] = await tx.select({ paypal: users.paypalMerchantId }).from(users).where(eq(users.id, caller.user.id));
    if (me?.paypal == null) {
      throw new ProblemException("PAYPAL_NOT_CONNECTED", 409, "Connect PayPal first", "You need a PayPal account that can receive payments before accepting a contract.");
    }

    await tx.update(invitations).set({ acceptedAt: new Date(), acceptedBy: caller.user.id }).where(eq(invitations.id, invitation.id));
    const [updated] = await tx
      .update(contracts)
      .set({ sellerId: caller.user.id, updatedAt: new Date() })
      .where(eq(contracts.id, contract.id))
      .returning();
    if (updated === undefined) throw new Error("update returned nothing");
    await recordAudit(tx, {
      actor: { type: "USER", id: caller.user.id },
      action: "contract.invitation.accepted",
      entityType: "Invitation",
      entityId: invitation.id,
      contractId: contract.id,
      after: { sellerId: caller.user.id },
      requestId: caller.requestId,
    });
    return contractView(tx, updated, caller.user.id);
  }
}
