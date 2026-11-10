// H1 (ADR-0004): create and approve a contract, against real Postgres (settld_test).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, contractVersions, invitations, milestones, outbox, users } from "../src/db/schema.js";
import { as, bootTestApp, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface VersionBody {
  id: string;
  version: number;
  status: string;
  snapshotHash: string | null;
  approvals: { partyRole: string }[];
}
interface ContractBody {
  id: string;
  status: string;
  myRole: string;
  currentVersion: VersionBody;
  milestones: { id: string; state: string; stateVersion: number }[];
}

describe("Contracts (H1)", () => {
  let ctx: TestContext;
  let buyer: string;
  let seller: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    buyer = await createUser(ctx.db, ["BUYER"]);
    seller = await createUser(ctx.db, ["SELLER"]);
  });

  async function createContract(): Promise<ContractBody> {
    const res = await as(ctx, buyer).post("/contracts", draftBody()).expect(201);
    return res.body as ContractBody;
  }

  async function inviteAndAccept(contractId: string): Promise<void> {
    await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email: "f@example.com" }).expect(202);
    await as(ctx, seller).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
  }

  async function submitted(): Promise<{ contractId: string; hash: string; version: number }> {
    const c = await createContract();
    await inviteAndAccept(c.id);
    const res = await as(ctx, buyer).post(`/contracts/${c.id}/draft:submit`).expect(200);
    const v = res.body as VersionBody;
    if (v.snapshotHash === null) throw new Error("no hash");
    return { contractId: c.id, hash: v.snapshotHash, version: v.version };
  }

  describe("createContract", () => {
    it("creates version 1 as DRAFT with every milestone in DRAFT", async () => {
      const c = await createContract();
      expect(c.status).toBe("DRAFT");
      expect(c.myRole).toBe("BUYER");
      expect(c.currentVersion).toMatchObject({ version: 1, status: "DRAFT", snapshotHash: null });
      expect(c.milestones.map((m) => m.state)).toEqual(["DRAFT", "DRAFT"]);
    });

    it("rejects a body that breaks the contract with VALIDATION_FAILED and field paths", async () => {
      const res = await as(ctx, buyer).post("/contracts", draftBody({ currency: "usd" })).expect(422);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(JSON.stringify(res.body)).toContain("currency");
    });

    it("requires an Idempotency-Key", async () => {
      const res = await as(ctx, buyer).post("/contracts", draftBody(), "not-a-uuid").expect(422);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("refuses a caller without the BUYER role", async () => {
      await as(ctx, seller).post("/contracts", draftBody()).expect(403);
    });
  });

  describe("idempotency", () => {
    it("replays the original response for the same key and body, and creates one contract", async () => {
      const key = randomUUID();
      const first = await as(ctx, buyer).post("/contracts", draftBody(), key).expect(201);
      const second = await as(ctx, buyer).post("/contracts", draftBody(), key).expect(201);
      expect(second.body).toEqual(first.body);
      const list = await as(ctx, buyer).get("/contracts").expect(200);
      expect((list.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it("answers IDEMPOTENCY_KEY_REUSED for the same key with another body", async () => {
      const key = randomUUID();
      await as(ctx, buyer).post("/contracts", draftBody(), key).expect(201);
      const res = await as(ctx, buyer).post("/contracts", draftBody({ title: "Other" }), key).expect(409);
      expect(res.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    });

    it("creates one contract when the same key arrives concurrently", async () => {
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 5 }, () => as(ctx, buyer).post("/contracts", draftBody(), key)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => (r.body as ContractBody).id)).size).toBe(1);
      const list = await as(ctx, buyer).get("/contracts").expect(200);
      expect((list.body as { items: unknown[] }).items).toHaveLength(1);
    });
  });

  describe("visibility (SB-7)", () => {
    it("answers NOT_FOUND to a non-party, never FORBIDDEN", async () => {
      const c = await createContract();
      const stranger = await createUser(ctx.db, ["BUYER"]);
      const res = await as(ctx, stranger).get(`/contracts/${c.id}`).expect(404);
      expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    });

    it("answers NOT_FOUND for a malformed id instead of a database error", async () => {
      await as(ctx, buyer).get("/contracts/not-a-uuid").expect(404);
    });
  });

  describe("invitations", () => {
    it("requires the seller to have PayPal connected (H1-G2)", async () => {
      const c = await createContract();
      const noPaypal = await createUser(ctx.db, ["SELLER"], false);
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: "f@example.com" }).expect(202);
      const res = await as(ctx, noPaypal).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(409);
      expect(res.body).toMatchObject({ code: "PAYPAL_NOT_CONNECTED" });
    });

    it("lets only one seller accept", async () => {
      const c = await createContract();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: "f@example.com" }).expect(202);
      const token = ctx.invitations.lastToken();
      const other = await createUser(ctx.db, ["SELLER"]);
      const results = await Promise.all([
        as(ctx, seller).post(`/invitations/${token}:accept`),
        as(ctx, other).post(`/invitations/${token}:accept`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it("answers NOT_FOUND for an unknown token", async () => {
      await as(ctx, seller).post("/invitations/nope:accept").expect(404);
    });
  });

  // listMyInvitations and acceptMyInvitation (openapi 0.8.0): the caller's verified email is
  // the proof instead of the link's token.
  describe("my invitations", () => {
    interface Pending {
      id: string;
      contractId: string;
      contractTitle: string;
      buyerName: string;
      total: { amountMinor: number; currency: string };
    }
    async function emailOf(userId: string): Promise<string> {
      const [u] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (u === undefined) throw new Error("no user");
      return u.email;
    }
    async function mine(userId: string): Promise<Pending[]> {
      return ((await as(ctx, userId).get("/me/invitations").expect(200)).body as { items: Pending[] }).items;
    }

    it("lists the pending invitations sent to my email, ignoring case, with what the seller needs to decide", async () => {
      const c = await createContract();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: (await emailOf(seller)).toUpperCase() }).expect(202);
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: "someone-else@example.com" }).expect(202);
      const items = await mine(seller);
      expect(items).toHaveLength(1);
      // draftBody: two milestones, 500.00 + 1500.00.
      expect(items[0]).toMatchObject({ contractId: c.id, contractTitle: "Checkout redesign", total: { amountMinor: 200_000, currency: "USD" } });
      expect(items[0]?.buyerName).toEqual(expect.any(String));
      expect(items[0]).not.toHaveProperty("token");
    });

    it("leaves out expired invitations and contracts that already have a seller", async () => {
      const expired = await createContract();
      await as(ctx, buyer).post(`/contracts/${expired.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      await ctx.db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.contractId, expired.id));
      const taken = await createContract();
      await as(ctx, buyer).post(`/contracts/${taken.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      const other = await createUser(ctx.db, ["SELLER"]);
      await as(ctx, buyer).post(`/contracts/${taken.id}/invitations`, { email: "x@example.com" }).expect(202);
      await as(ctx, other).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
      expect(await mine(seller)).toEqual([]);
    });

    it("an address invited twice appears once in the invitee's list", async () => {
      const c = await createContract();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      expect(await mine(seller)).toHaveLength(1);
      // The renewed token works: the newest link is the one sent last.
      await as(ctx, seller).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
    });

    it("the buyer sees whom they invited, the seller never does, and it clears once accepted", async () => {
      const c = await createContract();
      const before = (await as(ctx, buyer).get(`/contracts/${c.id}`).expect(200)).body as { pendingInvitation: unknown };
      expect(before.pendingInvitation).toBeNull();
      const email = await emailOf(seller);
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email }).expect(202);
      const pending = (await as(ctx, buyer).get(`/contracts/${c.id}`).expect(200)).body as { pendingInvitation: { email: string; expiresAt: string } | null };
      expect(pending.pendingInvitation?.email).toBe(email);
      expect(Date.parse(pending.pendingInvitation?.expiresAt ?? "")).toBeGreaterThan(Date.now());
      const [inv] = await mine(seller);
      if (inv === undefined) throw new Error("no invitation");
      const accepted = (await as(ctx, seller).post(`/me/invitations/${inv.id}:accept`).expect(200)).body as { pendingInvitation: unknown };
      expect(accepted.pendingInvitation).toBeNull();
      const after = (await as(ctx, buyer).get(`/contracts/${c.id}`).expect(200)).body as { pendingInvitation: unknown };
      expect(after.pendingInvitation).toBeNull();
    });

    it("accepts by id: I become the seller, and it leaves my list", async () => {
      const c = await createContract();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      const [inv] = await mine(seller);
      if (inv === undefined) throw new Error("no invitation");
      const res = await as(ctx, seller).post(`/me/invitations/${inv.id}:accept`).expect(200);
      expect((res.body as ContractBody).myRole).toBe("SELLER");
      expect(await mine(seller)).toEqual([]);
      // Again after success is a no-op, like the token route.
      await as(ctx, seller).post(`/me/invitations/${inv.id}:accept`).expect(200);
    });

    it("answers NOT_FOUND for an invitation sent to someone else, so ids reveal nothing", async () => {
      const c = await createContract();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      const [inv] = await mine(seller);
      if (inv === undefined) throw new Error("no invitation");
      const intruder = await createUser(ctx.db, ["SELLER"]);
      await as(ctx, intruder).post(`/me/invitations/${inv.id}:accept`).expect(404);
      await as(ctx, intruder).post(`/me/invitations/${randomUUID()}:accept`).expect(404);
      await as(ctx, intruder).post("/me/invitations/not-a-uuid:accept").expect(404);
    });

    it("previews the invited contract before accepting: terms, milestones and criteria, without the team", async () => {
      const c = await createContract();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      const [inv] = await mine(seller);
      if (inv === undefined) throw new Error("no invitation");
      // Not a party yet: the contract itself stays closed.
      await as(ctx, seller).get(`/contracts/${c.id}`).expect(404);
      const preview = (await as(ctx, seller).get(`/me/invitations/${inv.id}`).expect(200)).body as Record<string, unknown>;
      expect(preview).toMatchObject({ id: inv.id, contractId: c.id, contractTitle: "Checkout redesign", terms: { releaseCountdownSeconds: 172_800 } });
      const ms = preview.milestones as { title: string; criteria: { text: string }[] }[];
      expect(ms.map((m) => m.title)).toEqual(["Landing page", "Checkout flow"]);
      expect(ms[0]?.criteria[0]?.text).toBe("Staging answers 200");
      expect(preview).not.toHaveProperty("team");
    });

    it("previews only my own pending invitations", async () => {
      const c = await createContract();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: await emailOf(seller) }).expect(202);
      const [inv] = await mine(seller);
      if (inv === undefined) throw new Error("no invitation");
      const intruder = await createUser(ctx.db, ["SELLER"]);
      await as(ctx, intruder).get(`/me/invitations/${inv.id}`).expect(404);
      await as(ctx, seller).get("/me/invitations/not-a-uuid").expect(404);
      // Once accepted it is no longer an invitation to preview; the contract page takes over.
      await as(ctx, seller).post(`/me/invitations/${inv.id}:accept`).expect(200);
      await as(ctx, seller).get(`/me/invitations/${inv.id}`).expect(404);
    });

    it("keeps the same rules as the link: PayPal must be connected (H1-G2)", async () => {
      const c = await createContract();
      const noPaypal = await createUser(ctx.db, ["SELLER"], false);
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: await emailOf(noPaypal) }).expect(202);
      const [inv] = await mine(noPaypal);
      if (inv === undefined) throw new Error("no invitation");
      const res = await as(ctx, noPaypal).post(`/me/invitations/${inv.id}:accept`).expect(409);
      expect(res.body).toMatchObject({ code: "PAYPAL_NOT_CONNECTED" });
    });
  });

  describe("submit and approve", () => {
    it("freezes the version with a sha256 hash", async () => {
      const { hash } = await submitted();
      expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("locks the version when both parties approve the same hash, and runs SM-T01 once per milestone", async () => {
      const { contractId, hash, version } = await submitted();
      const first = await as(ctx, buyer).post(`/contracts/${contractId}/versions/${String(version)}:approve`, { snapshotHash: hash }).expect(200);
      expect((first.body as VersionBody).status).toBe("PENDING_APPROVAL");
      const second = await as(ctx, seller).post(`/contracts/${contractId}/versions/${String(version)}:approve`, { snapshotHash: hash }).expect(200);
      expect((second.body as VersionBody).status).toBe("LOCKED");

      const contract = (await as(ctx, buyer).get(`/contracts/${contractId}`).expect(200)).body as ContractBody;
      expect(contract.status).toBe("LOCKED");
      expect(contract.milestones.map((m) => [m.state, m.stateVersion])).toEqual([
        ["APPROVED", 1],
        ["APPROVED", 1],
      ]);

      const events = await ctx.db.select({ type: outbox.type }).from(outbox).where(eq(outbox.contractId, contractId));
      const types = events.map((e) => e.type);
      expect(types.filter((t) => t === "contracts.version.locked")).toHaveLength(1);
      expect(types.filter((t) => t === "payments.milestone.state_changed")).toHaveLength(2);

      const audits = await ctx.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.contractId, contractId), eq(auditLog.action, "milestone.transition.SM-T01")));
      expect(audits).toHaveLength(2);
    });

    // ADR-0004, failure mode 1. Repeated because a race that loses only sometimes is still a bug.
    it("locks exactly once when both parties approve at the same time", async () => {
      for (let round = 0; round < 10; round++) {
        const { contractId, hash, version } = await submitted();
        const path = `/contracts/${contractId}/versions/${String(version)}:approve`;
        const results = await Promise.all([
          as(ctx, buyer).post(path, { snapshotHash: hash }),
          as(ctx, seller).post(path, { snapshotHash: hash }),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);

        const [v] = await ctx.db.select().from(contractVersions).where(and(eq(contractVersions.contractId, contractId), eq(contractVersions.version, version)));
        expect(v?.status).toBe("LOCKED");
        const rows = await ctx.db.select().from(milestones).where(eq(milestones.contractId, contractId));
        expect(rows.every((m) => m.state === "APPROVED" && m.stateVersion === 1)).toBe(true);
        const [locked] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(outbox)
          .where(and(eq(outbox.contractId, contractId), eq(outbox.type, "contracts.version.locked")));
        expect(locked?.n).toBe(1);
      }
    });

    it("answers VERSION_HASH_MISMATCH for a hash the caller did not get from this version", async () => {
      const { contractId, version } = await submitted();
      const res = await as(ctx, buyer)
        .post(`/contracts/${contractId}/versions/${String(version)}:approve`, { snapshotHash: `sha256:${"0".repeat(64)}` })
        .expect(409);
      expect(res.body).toMatchObject({ code: "VERSION_HASH_MISMATCH" });
    });

    it("treats a second approval by the same party as a no-op", async () => {
      const { contractId, hash, version } = await submitted();
      const path = `/contracts/${contractId}/versions/${String(version)}:approve`;
      await as(ctx, buyer).post(path, { snapshotHash: hash }).expect(200);
      const again = await as(ctx, buyer).post(path, { snapshotHash: hash }).expect(200);
      expect((again.body as VersionBody).approvals).toHaveLength(1);
    });
  });

  describe("editing a version under approval (H1-G3)", () => {
    it("supersedes it with version N+1, and approving the old one answers STALE_STATE", async () => {
      const { contractId, hash, version } = await submitted();
      await as(ctx, buyer).post(`/contracts/${contractId}/versions/${String(version)}:approve`, { snapshotHash: hash }).expect(200);

      const edit = await as(ctx, seller).put(`/contracts/${contractId}/draft`, draftBody({ title: "Checkout redesign v2" }), String(version)).expect(200);
      expect(edit.body).toMatchObject({ version: version + 1, status: "DRAFT", snapshotHash: null, approvals: [] });

      const stale = await as(ctx, seller).post(`/contracts/${contractId}/versions/${String(version)}:approve`, { snapshotHash: hash }).expect(409);
      expect(stale.body).toMatchObject({ code: "STALE_STATE" });
    });

    it("answers STALE_STATE when If-Match is not the current version (lost update)", async () => {
      const c = await createContract();
      const res = await as(ctx, buyer).put(`/contracts/${c.id}/draft`, draftBody(), "7").expect(409);
      expect(res.body).toMatchObject({ code: "STALE_STATE" });
    });

    it("keeps milestone ids stable across edits when the caller sends them back", async () => {
      const c = await createContract();
      const body = draftBody();
      const ids = c.milestones.map((m) => m.id);
      const milestonesWithIds = (body.milestones as object[]).map((m, i) => ({ ...m, id: ids[i] }));
      const res = await as(ctx, buyer).put(`/contracts/${c.id}/draft`, { ...body, milestones: milestonesWithIds }, "1").expect(200);
      expect((res.body as { snapshot: { milestones: { id: string }[] } }).snapshot.milestones.map((m) => m.id)).toEqual(ids);
    });

    it("refuses a milestone id that belongs to another contract", async () => {
      const mine = await createContract();
      const other = await createContract();
      const foreignId = other.milestones[0]?.id;
      const body = draftBody();
      const milestonesWithIds = (body.milestones as object[]).map((m, i) => (i === 0 ? { ...m, id: foreignId } : m));
      const res = await as(ctx, buyer).put(`/contracts/${mine.id}/draft`, { ...body, milestones: milestonesWithIds }, "1").expect(422);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  describe("database invariants", () => {
    it("refuses to change a frozen snapshot (DM-INV-2)", async () => {
      const { contractId, version } = await submitted();
      await expect(
        ctx.db
          .update(contractVersions)
          .set({ snapshot: { tampered: true } })
          .where(and(eq(contractVersions.contractId, contractId), eq(contractVersions.version, version))),
      ).rejects.toThrow();
    });

    it("refuses to delete audit rows (DM-INV-5)", async () => {
      const c = await createContract();
      await expect(ctx.db.delete(auditLog).where(eq(auditLog.contractId, c.id))).rejects.toThrow();
    });
  });

  describe("getMe", () => {
    it("returns the caller with paypalReady", async () => {
      const res = await as(ctx, seller).get("/me").expect(200);
      expect(res.body).toMatchObject({ id: seller, roles: ["SELLER"], paypalReady: true });
    });
  });
});
