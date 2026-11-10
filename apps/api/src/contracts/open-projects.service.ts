// Open projects (ADR-0018): a buyer lists a contract and a seller takes it by agreeing to its terms.
//
// Nothing here moves money or a milestone by itself. Publishing is the buyer's approval, taking is the
// seller's approval, and the existing approve() locks the version when both exist. That reuse is the
// design: a parallel path to LOCKED would be a second place where the "same hash" rule could break.
import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { recordAudit } from "../audit/audit.js";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import { contracts, contractVersions, invitations, users } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { paypalReady } from "../accounts/onboarding.js";
import { decodeCursor, encodeCursor } from "../http/keyset-cursor.js";
import { notFound } from "../http/params.js";
import { enqueueEvent } from "../outbox/outbox.js";
import { contractView, isOpenProject, total } from "./contract-view.js";
import { ContractsService } from "./contracts.service.js";
import type { Caller } from "./contracts.service.js";
import { LOW_VERIFIABILITY, milestoneGuardFailures, verifiabilityScore } from "./snapshot.js";
import type { ContractSnapshot } from "./snapshot.js";

const PAGE_SIZE = 20;
const DAY_MS = 86_400_000;
const LISTING_DAYS = 30;
const MAX_PUBLISHED_PER_BUYER = 10;
const MAX_TAKEN_PER_DAY = 10;

const transitionRefused = (title: string, detail: string) => new ProblemException("INVALID_TRANSITION", 409, title, detail);

@Injectable()
export class OpenProjectsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly contractsService: ContractsService,
  ) {}

  // ---------------------------------------------------------------- publish

  async publish(tx: Tx, caller: Caller, contractId: string, version: number, acknowledgeLow: boolean) {
    const { contract, role } = await this.contractsService.lockContract(tx, contractId, caller);
    if (role !== "BUYER") throw new ProblemException("FORBIDDEN", 403, "Only the buyer can publish", "Ask the buyer of this contract to publish it.");
    const now = new Date();
    // A no-op, so a double click cannot extend a listing past the 30 days the buyer agreed to.
    if (isOpenProject(contract, now)) return contractView(tx, contract, caller.user.id);
    if (contract.sellerId !== null) throw transitionRefused("This contract already has a seller", "A contract has exactly one seller.");

    const [current] = await tx.select().from(contractVersions).where(eq(contractVersions.id, contract.currentVersionId ?? ""));
    if (current === undefined) throw new Error(`Contract ${contract.id} has no current version`);
    // The buyer publishes what was on screen, not "whatever is current".
    if (current.version !== version) {
      throw new ProblemException("STALE_STATE", 409, "This contract changed since you opened it", "Reload to see the latest version, then publish it.", {
        currentVersion: current.version,
      });
    }
    const [{ live } = { live: 0 }] = await tx
      .select({ live: count() })
      .from(invitations)
      .where(and(eq(invitations.contractId, contractId), isNull(invitations.acceptedAt), gt(invitations.expiresAt, now)));
    // Without this, an invited seller and a stranger would race for a contract the buyer meant for
    // one person.
    if (live > 0) throw transitionRefused("This contract has a pending invitation", "Wait for it to expire, or create a new contract to publish.");

    // Counted under this contract's lock only, so two publishes on different contracts can pass the
    // limit by one. It stops spam, not a security boundary, and a per-buyer lock would not be worth it.
    const [{ published } = { published: 0 }] = await tx
      .select({ published: count() })
      .from(contracts)
      .where(and(eq(contracts.buyerId, caller.user.id), isNull(contracts.sellerId), gt(contracts.publishedUntil, now)));
    if (published >= MAX_PUBLISHED_PER_BUYER) {
      throw new ProblemException("RATE_LIMITED", 429, "Too many open projects", `You can have ${String(MAX_PUBLISHED_PER_BUYER)} open projects at a time. Withdraw one first.`);
    }

    // submit and approve, not a shortcut: they carry G-MILESTONE-VALID, the low-verifiability
    // acknowledgement, the audit rows and the events. Any failure rolls back the whole publish.
    if (current.status === "DRAFT") await this.contractsService.submit(tx, caller, contractId);
    const [frozen] = await tx.select().from(contractVersions).where(eq(contractVersions.id, current.id));
    if (frozen?.snapshotHash == null) throw transitionRefused("This version cannot be published", `The current version is ${current.status}.`);
    // submit only checks a draft. A version submitted earlier may have a due date that has passed
    // since: listed, nobody would ever see it, and it would stay frozen and count toward the limit.
    this.contractsService.assertMilestonesValid(frozen.snapshot as ContractSnapshot);
    await this.contractsService.approve(tx, caller, contractId, version, frozen.snapshotHash, acknowledgeLow);

    const publishedUntil = new Date(now.getTime() + LISTING_DAYS * DAY_MS);
    const [updated] = await tx.update(contracts).set({ publishedAt: now, publishedUntil, updatedAt: now }).where(eq(contracts.id, contractId)).returning();
    if (updated === undefined) throw new Error("update returned nothing");
    await recordAudit(tx, {
      actor: { type: "USER", id: caller.user.id },
      action: "contract.published",
      entityType: "Contract",
      entityId: contractId,
      contractId,
      after: { version, snapshotHash: frozen.snapshotHash, publishedUntil },
      requestId: caller.requestId,
    });
    await enqueueEvent(tx, {
      type: "contracts.contract.published",
      actor: { type: "USER", id: caller.user.id },
      contractId,
      correlationId: caller.requestId,
      payload: { versionId: frozen.id, version, snapshotHash: frozen.snapshotHash, publishedUntil: publishedUntil.toISOString() },
    });
    return contractView(tx, updated, caller.user.id);
  }

  async unpublish(tx: Tx, caller: Caller, contractId: string) {
    const { contract, role } = await this.contractsService.lockContract(tx, contractId, caller);
    if (role !== "BUYER") throw new ProblemException("FORBIDDEN", 403, "Only the buyer can withdraw", "Ask the buyer of this contract to withdraw it.");
    if (contract.publishedAt === null || contract.sellerId !== null) throw transitionRefused("This project is not open", "Only an open project without a seller can be withdrawn.");
    const [updated] = await tx.update(contracts).set({ publishedAt: null, publishedUntil: null, updatedAt: new Date() }).where(eq(contracts.id, contractId)).returning();
    if (updated === undefined) throw new Error("update returned nothing");
    const [current] = await tx.select().from(contractVersions).where(eq(contractVersions.id, contract.currentVersionId ?? ""));
    await recordAudit(tx, {
      actor: { type: "USER", id: caller.user.id },
      action: "contract.unpublished",
      entityType: "Contract",
      entityId: contractId,
      contractId,
      requestId: caller.requestId,
    });
    await enqueueEvent(tx, {
      type: "contracts.contract.unpublished",
      actor: { type: "USER", id: caller.user.id },
      contractId,
      correlationId: caller.requestId,
      payload: { versionId: current?.id, version: current?.version },
    });
    return contractView(tx, updated, caller.user.id);
  }

  // ---------------------------------------------------------------- take

  async take(tx: Tx, caller: Caller, contractId: string, version: number, snapshotHash: string, acknowledgeLow: boolean) {
    const me = caller.user.id;
    // Not lockContract: it answers NOT_FOUND to non-parties, and the caller is not a party yet.
    // The lock is what makes two simultaneous takes safe: the second waits here, then reads the
    // first one's seller below.
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).for("update");
    if (contract === undefined) throw notFound();
    // A retry with a new key after a lost response must not look like losing the race.
    if (contract.sellerId === me && contract.takenAt !== null) return contractView(tx, contract, me);
    // Same answer for "never published" and "withdrawn": a draft's existence stays private.
    if (contract.publishedAt === null) throw notFound();
    if (contract.sellerId !== null) throw transitionRefused("Someone else took this project", "It is no longer available.");
    const now = new Date();
    if (!isOpenProject(contract, now)) throw transitionRefused("This listing expired", "It is no longer available.");
    if (contract.buyerId === me) throw new ProblemException("FORBIDDEN", 403, "You are the buyer of this contract", "The seller must be a different person.");
    if (!caller.user.roles.includes("SELLER")) throw new ProblemException("FORBIDDEN", 403, "Only sellers can take a project", "Your account has no SELLER role.");

    // Stricter than accepting an invitation on purpose: nobody chose this seller, so a linked account
    // that PayPal refuses would only surface when the buyer tries to fund.
    const [account] = await tx.select().from(users).where(eq(users.id, me));
    if (account === undefined || !paypalReady(account)) {
      throw new ProblemException("PAYPAL_NOT_CONNECTED", 409, "Connect PayPal first", "You need a PayPal account that can receive payments before taking a project.");
    }

    // The contract's lock does not serialize one seller's takes on different contracts, and this limit
    // is what stands between a bad actor and every buyer's list. Released at commit. Taken last, after
    // the contract's lock, so two takes can never wait on each other in opposite order.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`take:${me}`}, 0))`);
    const [{ taken } = { taken: 0 }] = await tx
      .select({ taken: count() })
      .from(contracts)
      .where(and(eq(contracts.sellerId, me), gt(contracts.takenAt, new Date(now.getTime() - DAY_MS))));
    if (taken >= MAX_TAKEN_PER_DAY) {
      throw new ProblemException("RATE_LIMITED", 429, "Too many projects today", `You can take ${String(MAX_TAKEN_PER_DAY)} projects in 24 hours. Try again tomorrow.`);
    }

    // The seller must exist before approve(), which authorizes by party role. Everything below shares
    // this transaction: a wrong hash or a due date that passed also undoes this update, so there is
    // never a seller who did not approve.
    await tx.update(contracts).set({ sellerId: me, takenAt: now, updatedAt: now }).where(eq(contracts.id, contractId));
    const approved = await this.contractsService.approve(tx, caller, contractId, version, snapshotHash, acknowledgeLow);
    await recordAudit(tx, {
      actor: { type: "USER", id: me },
      action: "contract.taken",
      entityType: "Contract",
      entityId: contractId,
      contractId,
      after: { sellerId: me, version, snapshotHash },
      requestId: caller.requestId,
    });
    await enqueueEvent(tx, {
      type: "contracts.contract.taken",
      actor: { type: "USER", id: me },
      contractId,
      correlationId: caller.requestId,
      payload: { sellerId: me, versionId: approved.id, version, snapshotHash },
    });
    const [updated] = await tx.select().from(contracts).where(eq(contracts.id, contractId));
    if (updated === undefined) throw new Error("contract vanished");
    return contractView(tx, updated, me);
  }

  // ---------------------------------------------------------------- reads

  async list(viewerId: string, rawCursor: string | undefined) {
    const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
    const rows = await this.openProjects(
      cursor === null ? undefined : or(lt(contracts.publishedAt, cursor.at), and(eq(contracts.publishedAt, cursor.at), lt(contracts.id, cursor.id))),
    );
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      // After the page is cut, so nextCursor stays correct: a page can be short, never skip anyone.
      // The same rule as the lock, so the list does not offer what taking would refuse.
      items: page.filter((r) => this.canStillLock(r.snapshot as ContractSnapshot)).map((r) => this.summary(r, viewerId)),
      nextCursor: rows.length > PAGE_SIZE && last?.publishedAt != null ? encodeCursor(last.publishedAt, last.id) : null,
    };
  }

  async get(viewerId: string, contractId: string) {
    const [row] = await this.openProjects(eq(contracts.id, contractId));
    if (row === undefined || !this.canStillLock(row.snapshot as ContractSnapshot) || row.snapshotHash === null) throw notFound();
    const snapshot = row.snapshot as ContractSnapshot;
    return {
      ...this.summary(row, viewerId),
      description: snapshot.description,
      terms: snapshot.terms,
      milestones: snapshot.milestones,
      version: row.version,
      snapshotHash: row.snapshotHash,
      lowVerifiabilityCount: snapshot.milestones.filter((m) => verifiabilityScore(m) < LOW_VERIFIABILITY).length,
    };
  }

  private canStillLock(snapshot: ContractSnapshot): boolean {
    return milestoneGuardFailures(snapshot, new Date().toISOString().slice(0, 10)).length === 0;
  }

  private openProjects(extra: ReturnType<typeof eq> | ReturnType<typeof or> | undefined) {
    return this.db
      .select({
        id: contracts.id,
        buyerId: contracts.buyerId,
        publishedAt: contracts.publishedAt,
        publishedUntil: contracts.publishedUntil,
        buyerName: users.displayName,
        snapshot: contractVersions.snapshot,
        snapshotHash: contractVersions.snapshotHash,
        version: contractVersions.version,
      })
      .from(contracts)
      .innerJoin(contractVersions, eq(contractVersions.id, contracts.currentVersionId))
      .innerJoin(users, eq(users.id, contracts.buyerId))
      .where(
        and(
          isNotNull(contracts.publishedAt),
          isNull(contracts.sellerId),
          gt(contracts.publishedUntil, sql`now()`),
          extra,
        ),
      )
      .orderBy(desc(contracts.publishedAt), desc(contracts.id))
      .limit(PAGE_SIZE + 1);
  }

  private summary(
    row: { id: string; buyerId: string; buyerName: string; publishedAt: Date | null; publishedUntil: Date | null; snapshot: unknown },
    viewerId: string,
  ) {
    const snapshot = row.snapshot as ContractSnapshot;
    return {
      contractId: row.id,
      title: snapshot.title,
      buyerName: row.buyerName,
      total: total(snapshot),
      milestoneCount: snapshot.milestones.length,
      publishedAt: row.publishedAt,
      publishedUntil: row.publishedUntil,
      isMine: row.buyerId === viewerId,
    };
  }
}
