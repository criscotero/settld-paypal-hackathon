// ADR-0018: a buyer publishes a project and a seller takes it, against real Postgres.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLog, contracts, contractVersions, invitations, outbox, paymentEvents, users } from "../src/db/schema.js";
import type { Caller } from "../src/contracts/contracts.service.js";
import { OpenProjectsService } from "../src/contracts/open-projects.service.js";
import { as, bootTestApp, createNewUser, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface VersionBody {
  version: number;
  status: string;
  snapshotHash: string | null;
  approvals: { partyRole: string }[];
}
interface ContractBody {
  id: string;
  status: string;
  buyerId: string;
  sellerId: string | null;
  publishedUntil: string | null;
  currentVersion: VersionBody;
  milestones: { id: string; state: string }[];
}
interface Summary {
  contractId: string;
  title: string;
  buyerName: string;
  total: { amountMinor: number; currency: string };
  milestoneCount: number;
  isMine: boolean;
}
interface Detail extends Summary {
  version: number;
  snapshotHash: string;
  lowVerifiabilityCount: number;
  milestones: unknown[];
}
interface Page {
  items: Summary[];
  nextCursor: string | null;
}

const LOW_VERIFIABILITY_DRAFT = () =>
  draftBody({
    milestones: [
      {
        title: "Brand story",
        amount: { amountMinor: 50_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: [{ text: "The buyer likes it", level: "HUMAN", required: true, weightBps: 10_000 }],
      },
    ],
  });

describe("Open projects (ADR-0018)", () => {
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

  async function draft(by = buyer, body: object = draftBody()): Promise<ContractBody> {
    return (await as(ctx, by).post("/contracts", body).expect(201)).body as ContractBody;
  }

  async function published(by = buyer, body: object = draftBody()): Promise<ContractBody> {
    const c = await draft(by, body);
    const res = await as(ctx, by)
      .post(`/contracts/${c.id}:publish`, { version: c.currentVersion.version, acknowledgeLowVerifiability: true })
      .expect(200);
    return res.body as ContractBody;
  }

  const terms = (c: ContractBody) => ({ version: c.currentVersion.version, snapshotHash: c.currentVersion.snapshotHash });
  const take = (c: ContractBody, by = seller, key?: string) => as(ctx, by).post(`/contracts/${c.id}:take`, terms(c), key);

  async function listed(contractId: string, viewer = seller): Promise<Summary | undefined> {
    const items: Summary[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `?cursor=${cursor}`;
      const page = (await as(ctx, viewer).get(`/open-projects${query}`).expect(200)).body as Page;
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return items.find((i) => i.contractId === contractId);
  }

  // A frozen snapshot cannot be edited (DM-INV-2), so the test moves the clock instead of the date.
  const DAY_MS = 86_400_000;
  const soonDue = () =>
    draftBody({
      milestones: [
        {
          title: "Soon",
          amount: { amountMinor: 50_000, currency: "USD" },
          dueDate: new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10),
          criteria: [{ text: "Tests pass", level: "AUTOMATIC", required: true, weightBps: 10_000, checkType: "TESTS_PASSED", checkConfig: {} }],
        },
      ],
    });
  async function afterDueDate(check: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * DAY_MS });
    try {
      await check();
    } finally {
      vi.useRealTimers();
    }
  }

  const lockedJobs = () => ctx.jobs.of("notifications.send").filter((j) => j.data.templateKey === "contract.locked");

  async function row(contractId: string) {
    const [c] = await ctx.db.select().from(contracts).where(eq(contracts.id, contractId));
    if (c === undefined) throw new Error("no contract");
    return c;
  }

  describe("publishContract", () => {
    it("freezes the version, records the buyer's approval and lists it for 30 days", async () => {
      const c = await published();
      expect(c.currentVersion.status).toBe("PENDING_APPROVAL");
      expect(c.currentVersion.approvals.map((a) => a.partyRole)).toEqual(["BUYER"]);
      expect(c.sellerId).toBeNull();
      const days = (new Date(c.publishedUntil ?? 0).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
      const events = await ctx.db.select().from(outbox).where(and(eq(outbox.contractId, c.id), eq(outbox.type, "contracts.contract.published")));
      expect(events).toHaveLength(1);
      const audit = await ctx.db.select().from(auditLog).where(and(eq(auditLog.contractId, c.id), eq(auditLog.action, "contract.published")));
      expect(audit).toHaveLength(1);
    });

    it("also publishes a version the buyer already submitted", async () => {
      const c = await draft();
      await as(ctx, buyer).post(`/contracts/${c.id}/draft:submit`).expect(200);
      const res = await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(200);
      expect((res.body as ContractBody).currentVersion.status).toBe("PENDING_APPROVAL");
    });

    it("is refused for a submitted version whose due date passed, which nobody could ever see", async () => {
      const c = await draft(buyer, soonDue());
      await as(ctx, buyer).post(`/contracts/${c.id}/draft:submit`).expect(200);
      await afterDueDate(async () => {
        const res = await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(409);
        expect(res.body).toMatchObject({ code: "GUARD_FAILED" });
      });
      expect((await row(c.id)).publishedAt).toBeNull();
    });

    it("is refused for a version the buyer did not see", async () => {
      const c = await draft();
      const res = await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 2 }).expect(409);
      expect(res.body).toMatchObject({ code: "STALE_STATE" });
      expect((await row(c.id)).publishedAt).toBeNull();
    });

    it("needs the acknowledgement for a milestone that is hard to verify, and leaves nothing behind", async () => {
      const c = await draft(buyer, LOW_VERIFIABILITY_DRAFT());
      await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(422);
      const [v] = await ctx.db.select().from(contractVersions).where(eq(contractVersions.contractId, c.id));
      expect(v?.status).toBe("DRAFT");
      expect((await row(c.id)).publishedAt).toBeNull();
    });

    it("is only for the buyer, and hides the contract from strangers", async () => {
      const c = await draft();
      await as(ctx, seller).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(404);
    });

    it("is refused when the contract has a live invitation, but not an expired one", async () => {
      const c = await draft();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: "s@example.com" }).expect(202);
      const res = await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(409);
      expect(res.body).toMatchObject({ code: "INVALID_TRANSITION" });
      await ctx.db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.contractId, c.id));
      await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(200);
    });

    it("is refused when the contract already has a seller", async () => {
      const c = await draft();
      await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: "s@example.com" }).expect(202);
      await as(ctx, seller).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
      await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(409);
    });

    it("publishing twice is a no-op that keeps the first deadline", async () => {
      const c = await published();
      const again = await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(200);
      expect((again.body as ContractBody).publishedUntil).toBe(c.publishedUntil);
    });

    it("stops at 10 published projects per buyer", async () => {
      for (let i = 0; i < 10; i += 1) await published();
      const c = await draft();
      const res = await as(ctx, buyer).post(`/contracts/${c.id}:publish`, { version: 1 }).expect(429);
      expect(res.body).toMatchObject({ code: "RATE_LIMITED" });
    });

    it("does not count expired projects toward the limit", async () => {
      const old = await published();
      await ctx.db.update(contracts).set({ publishedUntil: new Date(Date.now() - 1000) }).where(eq(contracts.id, old.id));
      for (let i = 0; i < 9; i += 1) await published();
      await published();
    });
  });

  describe("while published", () => {
    it("the contract cannot be edited", async () => {
      const c = await published();
      const res = await as(ctx, buyer).put(`/contracts/${c.id}/draft`, draftBody({ title: "Changed" }), "1").expect(409);
      expect(res.body).toMatchObject({ code: "INVALID_TRANSITION" });
    });

    it("the buyer cannot invite anyone", async () => {
      const c = await published();
      const res = await as(ctx, buyer).post(`/contracts/${c.id}/invitations`, { email: "s@example.com" }).expect(409);
      expect(res.body).toMatchObject({ code: "INVALID_TRANSITION" });
    });
  });

  describe("unpublishContract", () => {
    it("removes it from the list and lets the buyer edit again", async () => {
      const c = await published();
      const res = await as(ctx, buyer).post(`/contracts/${c.id}:unpublish`).expect(200);
      expect((res.body as ContractBody).publishedUntil).toBeNull();
      expect(await listed(c.id)).toBeUndefined();
      await as(ctx, buyer).put(`/contracts/${c.id}/draft`, draftBody({ title: "Changed" }), "1").expect(200);
    });

    it("is only for the buyer", async () => {
      const c = await published();
      await as(ctx, seller).post(`/contracts/${c.id}:unpublish`).expect(404);
    });

    it("is refused for a contract that is not published", async () => {
      const c = await draft();
      await as(ctx, buyer).post(`/contracts/${c.id}:unpublish`).expect(409);
    });

    it("is refused once a seller took it", async () => {
      const c = await published();
      await take(c).expect(200);
      await as(ctx, buyer).post(`/contracts/${c.id}:unpublish`).expect(409);
    });

    it("the same seller's stale link cannot take a withdrawn project", async () => {
      const c = await published();
      await as(ctx, buyer).post(`/contracts/${c.id}:unpublish`).expect(200);
      await take(c).expect(404);
      expect((await row(c.id)).sellerId).toBeNull();
    });
  });

  describe("listOpenProjects and getOpenProject", () => {
    it("show the project to any onboarded user, without emails", async () => {
      const c = await published();
      const stranger = await createUser(ctx.db, ["COLLABORATOR"]);
      const item = await listed(c.id, stranger);
      expect(item).toMatchObject({ total: { amountMinor: 200_000, currency: "USD" }, milestoneCount: 2, isMine: false });
      const detail = (await as(ctx, stranger).get(`/open-projects/${c.id}`).expect(200)).body as Detail;
      expect(detail).toMatchObject({ version: 1, snapshotHash: c.currentVersion.snapshotHash, lowVerifiabilityCount: 0 });
      expect(detail.milestones).toHaveLength(2);
      expect(JSON.stringify([item, detail])).not.toMatch(/@test\.settld\.app/);
    });

    it("marks the buyer's own project", async () => {
      const c = await published();
      expect((await listed(c.id, buyer))?.isMine).toBe(true);
    });

    it("do not show a draft, and answer NOT_FOUND for it", async () => {
      const c = await draft();
      expect(await listed(c.id)).toBeUndefined();
      await as(ctx, seller).get(`/open-projects/${c.id}`).expect(404);
    });

    it("are closed to someone who has not finished onboarding", async () => {
      const newcomer = await createNewUser(ctx.db);
      const res = await as(ctx, newcomer).get("/open-projects").expect(403);
      expect(res.body).toMatchObject({ code: "ONBOARDING_INCOMPLETE" });
    });

    it("drop an expired listing", async () => {
      const c = await published();
      await ctx.db.update(contracts).set({ publishedUntil: new Date(Date.now() - 1000) }).where(eq(contracts.id, c.id));
      expect(await listed(c.id)).toBeUndefined();
      await as(ctx, seller).get(`/open-projects/${c.id}`).expect(404);
    });

    it("drop a project with a due date that passed, which could never lock", async () => {
      const c = await published(buyer, soonDue());
      await afterDueDate(async () => {
        expect(await listed(c.id)).toBeUndefined();
        await as(ctx, seller).get(`/open-projects/${c.id}`).expect(404);
      });
    });

    it("drop a project once it is taken", async () => {
      const c = await published();
      await take(c).expect(200);
      expect(await listed(c.id)).toBeUndefined();
      await as(ctx, seller).get(`/open-projects/${c.id}`).expect(404);
    });
  });

  describe("takeContract", () => {
    it("makes the caller the seller and locks the buyer's terms in one step", async () => {
      const c = await published();
      const res = await take(c).expect(200);
      const body = res.body as ContractBody;
      expect(body.sellerId).toBe(seller);
      expect(body.currentVersion.status).toBe("LOCKED");
      expect(body.currentVersion.approvals.map((a) => a.partyRole).sort()).toEqual(["BUYER", "SELLER"]);
      expect(body.milestones.every((m) => m.state === "APPROVED")).toBe(true);
      const types = (await ctx.db.select().from(outbox).where(eq(outbox.contractId, c.id))).map((e) => e.type);
      expect(types).toEqual(expect.arrayContaining(["contracts.contract.taken", "contracts.version.locked"]));
      const audit = await ctx.db.select().from(auditLog).where(and(eq(auditLog.contractId, c.id), eq(auditLog.action, "contract.taken")));
      expect(audit).toHaveLength(1);
    });

    it("leaves the milestone ready for the buyer to fund: no hold, no money", async () => {
      const c = await published();
      const body = (await take(c).expect(200)).body as { milestones: { id: string; holdStatus: string; nextStep: { actor: string; kind: string } }[] };
      expect(body.milestones[0]?.nextStep).toMatchObject({ actor: "BUYER", kind: "FUND" });
      expect(body.milestones.every((m) => m.holdStatus === "NONE")).toBe(true);
      expect(await ctx.db.select().from(paymentEvents).where(inArray(paymentEvents.milestoneId, body.milestones.map((m) => m.id)))).toEqual([]);
    });

    it("leaves the buyer a way out: a taken project that was not funded can be cancelled", async () => {
      const c = await published();
      const body = (await take(c).expect(200)).body as { milestones: { id: string; stateVersion: number }[] };
      for (const m of body.milestones) {
        const res = await as(ctx, buyer).post(`/milestones/${m.id}:cancel`, { reason: "Not the right fit" }).set("If-Match", String(m.stateVersion)).expect(200);
        expect(res.body).toMatchObject({ state: "VOIDED" });
      }
    });

    it("lets only one of two sellers take it at the same time", async () => {
      const c = await published();
      const other = await createUser(ctx.db, ["SELLER"]);
      const results = await Promise.all([take(c, seller), take(c, other)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)?.body as ContractBody;
      expect((await row(c.id)).sellerId).toBe(winner.sellerId);
      const events = await ctx.db.select().from(outbox).where(and(eq(outbox.contractId, c.id), eq(outbox.type, "contracts.contract.taken")));
      expect(events).toHaveLength(1);
    });

    it("gives one winner when a seller takes it while the buyer withdraws it", async () => {
      const c = await published();
      const [taken, withdrawn] = await Promise.all([take(c), as(ctx, buyer).post(`/contracts/${c.id}:unpublish`)]);
      const after = await row(c.id);
      if (taken.status === 200) {
        expect(withdrawn.status).toBe(409);
        expect(after.sellerId).toBe(seller);
      } else {
        expect([taken.status, withdrawn.status]).toEqual([404, 200]);
        expect(after.sellerId).toBeNull();
      }
    });

    it("replays the answer when a request is retried with the same key", async () => {
      const c = await published();
      const key = randomUUID();
      const first = await take(c, seller, key).expect(200);
      const second = await take(c, seller, key).expect(200);
      expect((second.body as ContractBody).id).toBe((first.body as ContractBody).id);
      const events = await ctx.db.select().from(outbox).where(and(eq(outbox.contractId, c.id), eq(outbox.type, "contracts.contract.taken")));
      expect(events).toHaveLength(1);
    });

    it("is a no-op for the seller who already took it, even with a new key", async () => {
      const c = await published();
      await take(c).expect(200);
      const again = await take(c).expect(200);
      expect((again.body as ContractBody).sellerId).toBe(seller);
    });

    it("refuses a hash that is not what was published, and changes nothing", async () => {
      const c = await published();
      const res = await as(ctx, seller).post(`/contracts/${c.id}:take`, { version: 1, snapshotHash: `sha256:${"0".repeat(64)}` }).expect(409);
      expect(res.body).toMatchObject({ code: "VERSION_HASH_MISMATCH" });
      expect((await row(c.id)).sellerId).toBeNull();
    });

    it("refuses the buyer", async () => {
      const both = await createUser(ctx.db, ["BUYER", "SELLER"]);
      const c = await published(both);
      const res = await take(c, both).expect(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses someone without the seller role", async () => {
      const c = await published();
      const collaborator = await createUser(ctx.db, ["COLLABORATOR"]);
      await take(c, collaborator).expect(403);
    });

    it("refuses someone who has not finished onboarding", async () => {
      const c = await published();
      const newcomer = await createNewUser(ctx.db);
      const res = await take(c, newcomer).expect(403);
      expect(res.body).toMatchObject({ code: "ONBOARDING_INCOMPLETE" });
    });

    it("refuses a seller whose PayPal account cannot receive payments", async () => {
      const c = await published();
      const noPaypal = await createUser(ctx.db, ["SELLER"], false);
      const res = await take(c, noPaypal).expect(409);
      expect(res.body).toMatchObject({ code: "PAYPAL_NOT_CONNECTED" });
      const linkedOnly = await createUser(ctx.db, ["SELLER"]);
      await ctx.db.update(users).set({ paypalPaymentsReceivable: false }).where(eq(users.id, linkedOnly));
      await take(c, linkedOnly).expect(409);
      expect((await row(c.id)).sellerId).toBeNull();
    });

    it("needs the acknowledgement for a milestone that is hard to verify, and rolls back the seller", async () => {
      const c = await published(buyer, LOW_VERIFIABILITY_DRAFT());
      await as(ctx, seller).post(`/contracts/${c.id}:take`, terms(c)).expect(422);
      expect((await row(c.id)).sellerId).toBeNull();
      await as(ctx, seller).post(`/contracts/${c.id}:take`, { ...terms(c), acknowledgeLowVerifiability: true }).expect(200);
    });

    it("rolls back the whole take when a due date already passed", async () => {
      const c = await published(buyer, soonDue());
      await afterDueDate(async () => {
        const res = await take(c).expect(409);
        expect(res.body).toMatchObject({ code: "GUARD_FAILED" });
      });
      const after = await row(c.id);
      expect(after.sellerId).toBeNull();
      expect(after.takenAt).toBeNull();
    });

    it("leaves no trace when the connection dies before the commit, as with kill -9", async () => {
      const c = await published();
      const [user] = await ctx.db.select().from(users).where(eq(users.id, seller));
      const caller = { user: { id: seller, roles: user?.roles ?? [] }, requestId: "req_crash" } as unknown as Caller;
      const service = ctx.app.get(OpenProjectsService);
      await expect(
        ctx.db.transaction(async (tx) => {
          await service.take(tx, caller, c.id, 1, c.currentVersion.snapshotHash ?? "", false);
          await tx.execute(sql`select pg_terminate_backend(pg_backend_pid())`);
        }),
      ).rejects.toThrow();
      const after = await row(c.id);
      expect(after.sellerId).toBeNull();
      expect(after.takenAt).toBeNull();
      const [version] = await ctx.db.select().from(contractVersions).where(eq(contractVersions.contractId, c.id));
      expect(version?.status).toBe("PENDING_APPROVAL");
      expect(await ctx.db.select().from(outbox).where(and(eq(outbox.contractId, c.id), eq(outbox.type, "contracts.contract.taken")))).toEqual([]);
      await take(c).expect(200);
    });

    it("refuses an expired listing", async () => {
      const c = await published();
      await ctx.db.update(contracts).set({ publishedUntil: new Date(Date.now() - 1000) }).where(eq(contracts.id, c.id));
      const res = await take(c).expect(409);
      expect(res.body).toMatchObject({ code: "INVALID_TRANSITION" });
    });

    it("answers NOT_FOUND for a contract that was never published", async () => {
      const c = await draft();
      await as(ctx, seller).post(`/contracts/${c.id}:take`, { version: 1, snapshotHash: `sha256:${"0".repeat(64)}` }).expect(404);
    });

    it("holds the limit when one seller takes many projects at the same time", async () => {
      const projects = await Promise.all(Array.from({ length: 12 }, async () => published(await createUser(ctx.db, ["BUYER"]))));
      const results = await Promise.all(projects.map((c) => take(c)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(10);
      expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    });

    it("stops a seller at 10 taken projects in 24 hours", async () => {
      for (let i = 0; i < 10; i += 1) await take(await published(await createUser(ctx.db, ["BUYER"]))).expect(200);
      const c = await published();
      const res = await take(c).expect(429);
      expect(res.body).toMatchObject({ code: "RATE_LIMITED" });
      expect((await row(c.id)).sellerId).toBeNull();
    });
  });

  describe("the contract.locked mail (ADR-0018)", () => {
    const jobFor = (c: ContractBody) => {
      const job = lockedJobs().find((j) => j.data.deepLink === `/contracts/${c.id}`);
      if (job === undefined) throw new Error("no contract.locked job");
      return job;
    };

    beforeEach(() => {
      ctx.emails.sent.length = 0;
      ctx.emails.failNext = false;
    });

    it("taking a project tells the buyer who took it and that funding comes next", async () => {
      const c = await published();
      await take(c).expect(200);
      expect(await ctx.notifications.process(jobFor(c).data as never)).toBe("SENT");

      const [sellerRow] = await ctx.db.select({ name: users.displayName }).from(users).where(eq(users.id, seller));
      const [buyerRow] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, buyer));
      const mail = ctx.emails.sent.find((m) => m.to === buyerRow?.email);
      expect(mail?.text).toContain(sellerRow?.name);
      expect(mail?.text).toContain("Fund");
      expect(mail?.text).toContain(`/contracts/${c.id}`);
    });

    it("both parties get one mail, even if the job runs twice", async () => {
      const c = await published();
      await take(c).expect(200);
      const job = jobFor(c);
      expect(job.data.recipientIds).toEqual([buyer, seller]);
      await ctx.notifications.process(job.data as never);
      expect(await ctx.notifications.process(job.data as never)).toBe("ALREADY_SENT");
      expect(ctx.emails.sent).toHaveLength(2);
    });

    it("publishing alone sends nothing: nobody agreed yet", async () => {
      const c = await published();
      expect(lockedJobs().some((j) => j.data.deepLink === `/contracts/${c.id}`)).toBe(false);
    });

    it("a take retried with a new key does not schedule a second mail", async () => {
      const c = await published();
      await take(c, seller, randomUUID()).expect(200);
      const before = lockedJobs().length;
      await take(c, seller, randomUUID()).expect(200);
      expect(lockedJobs()).toHaveLength(before);
    });

    it("a mail that runs after the buyer funded says nothing: asking to fund again would be wrong", async () => {
      const c = await published();
      const taken = (await take(c).expect(200)).body as ContractBody;
      const id = taken.milestones[0]?.id ?? "";
      const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
      await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: (order.body as { paypalOrderId: string }).paypalOrderId }).expect(200);
      expect(await ctx.notifications.process(jobFor(c).data as never)).toBe("SUPPRESSED");
      expect(ctx.emails.sent).toHaveLength(0);
    });
  });
});
