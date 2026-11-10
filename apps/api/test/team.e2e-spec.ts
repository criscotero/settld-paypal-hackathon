// ADR-0009, step 2: the team is part of the contract version, and every member approves it.
import { as, bootTestApp, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface TeamEntry {
  userId: string | null;
  displayName: string;
  role: string;
  shareBps: number | null;
  isSeller: boolean;
  approvedCurrentVersion: boolean;
}
interface ContractBody {
  id: string;
  myRole: string;
  team: TeamEntry[];
  currentVersion: { version: number; status: string; snapshotHash: string | null; snapshot: { team?: unknown } };
}

describe("Team and collaborators (ADR-0009)", () => {
  let ctx: TestContext;
  let buyer: string;
  let seller: string;
  let ana: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    buyer = await createUser(ctx.db, ["BUYER"]);
    seller = await createUser(ctx.db, ["SELLER"]);
    ana = await createUser(ctx.db, ["COLLABORATOR"]);
  });

  // A contract with its seller, and Ana added as a collaborator party.
  async function withCollaborator(): Promise<string> {
    const created = await as(ctx, buyer).post("/contracts", draftBody()).expect(201);
    const id = (created.body as ContractBody).id;
    await as(ctx, buyer).post(`/contracts/${id}/invitations`, { email: "s@example.com" }).expect(202);
    await as(ctx, seller).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
    await as(ctx, seller).post(`/contracts/${id}/team`, { userId: ana }).expect(201);
    return id;
  }

  const team70_30 = (collaborator: string) => [
    { userId: null, role: "Lead developer", shareBps: 7_000 },
    { userId: collaborator, role: "Designer", shareBps: 3_000 },
  ];

  // Returns the request without awaiting it, so callers can chain .expect().
  async function setTeam(id: string, team: object[], who = seller) {
    const c = (await as(ctx, who).get(`/contracts/${id}`).expect(200)).body as ContractBody;
    return { expect: (status: number) => as(ctx, who).put(`/contracts/${id}/draft`, draftBody({ team }), String(c.currentVersion.version)).expect(status) };
  }

  it("the seller adds a collaborator, who then sees the contract as COLLABORATOR", async () => {
    const id = await withCollaborator();
    const asAna = (await as(ctx, ana).get(`/contracts/${id}`).expect(200)).body as ContractBody;
    expect(asAna.myRole).toBe("COLLABORATOR");
    const list = (await as(ctx, ana).get("/contracts?role=COLLABORATOR").expect(200)).body as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toContain(id);
  });

  it("only the seller adds collaborators, and only people PayPal can pay", async () => {
    const id = await withCollaborator();
    const other = await createUser(ctx.db, ["COLLABORATOR"]);
    expect((await as(ctx, buyer).post(`/contracts/${id}/team`, { userId: other }).expect(403)).body).toMatchObject({ code: "FORBIDDEN" });
    const unpaid = await createUser(ctx.db, ["COLLABORATOR"], false);
    expect((await as(ctx, seller).post(`/contracts/${id}/team`, { userId: unpaid }).expect(409)).body).toMatchObject({ code: "PAYPAL_NOT_CONNECTED" });
    const buyerOnly = await createUser(ctx.db, ["BUYER"]);
    expect((await as(ctx, seller).post(`/contracts/${id}/team`, { userId: buyerOnly }).expect(422)).body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("allows at most 4 collaborators", async () => {
    const id = await withCollaborator();
    for (let i = 0; i < 3; i++) await as(ctx, seller).post(`/contracts/${id}/team`, { userId: await createUser(ctx.db, ["COLLABORATOR"]) }).expect(201);
    const fifth = await as(ctx, seller).post(`/contracts/${id}/team`, { userId: await createUser(ctx.db, ["COLLABORATOR"]) }).expect(422);
    expect(fifth.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("validates the team in the draft: shares sum to 100%, one seller slot, only collaborator parties", async () => {
    const id = await withCollaborator();
    const stranger = await createUser(ctx.db, ["COLLABORATOR"]);
    for (const bad of [
      [{ userId: null, role: "Lead", shareBps: 7_000 }, { userId: ana, role: "Designer", shareBps: 2_000 }],
      [{ userId: null, role: "Lead", shareBps: 5_000 }, { userId: null, role: "Lead", shareBps: 5_000 }],
      [{ userId: null, role: "Lead", shareBps: 7_000 }, { userId: stranger, role: "Designer", shareBps: 3_000 }],
    ]) {
      const res = await (await setTeam(id, bad)).expect(422);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await (await setTeam(id, team70_30(ana))).expect(200);
  });

  it("a draft without a team is the seller alone at 100%, written into the snapshot", async () => {
    const created = await as(ctx, buyer).post("/contracts", draftBody()).expect(201);
    const body = created.body as ContractBody;
    expect(body.currentVersion.snapshot.team).toEqual([{ userId: null, role: "Seller", shareBps: 10_000 }]);
  });

  it("a collaborator can read and approve, never edit or submit", async () => {
    const id = await withCollaborator();
    const c = (await as(ctx, ana).get(`/contracts/${id}`).expect(200)).body as ContractBody;
    expect((await as(ctx, ana).put(`/contracts/${id}/draft`, draftBody(), String(c.currentVersion.version)).expect(403)).body).toMatchObject({ code: "FORBIDDEN" });
    expect((await as(ctx, ana).post(`/contracts/${id}/draft:submit`).expect(403)).body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("locks only when the buyer, the seller and every collaborator in the team approved the same hash", async () => {
    const id = await withCollaborator();
    await (await setTeam(id, team70_30(ana))).expect(200);
    const submitted = (await as(ctx, seller).post(`/contracts/${id}/draft:submit`).expect(200)).body as { version: number; snapshotHash: string };
    const approve = (who: string) => as(ctx, who).post(`/contracts/${id}/versions/${String(submitted.version)}:approve`, { snapshotHash: submitted.snapshotHash, acknowledgeLowVerifiability: true });

    await approve(buyer).expect(200);
    const afterTwo = (await approve(seller).expect(200)).body as { status: string };
    expect(afterTwo.status).toBe("PENDING_APPROVAL");
    const afterAna = (await approve(ana).expect(200)).body as { status: string };
    expect(afterAna.status).toBe("LOCKED");

    const view = (await as(ctx, buyer).get(`/contracts/${id}`).expect(200)).body as ContractBody;
    expect(view.team.map((t) => [t.isSeller, t.role, t.shareBps, t.approvedCurrentVersion])).toEqual([
      [true, "Lead developer", 7_000, true],
      [false, "Designer", 3_000, true],
    ]);
  });

  it("a party left out of the team cannot approve", async () => {
    const id = await withCollaborator();
    const submitted = (await as(ctx, seller).post(`/contracts/${id}/draft:submit`).expect(200)).body as { version: number; snapshotHash: string };
    const res = await as(ctx, ana).post(`/contracts/${id}/versions/${String(submitted.version)}:approve`, { snapshotHash: submitted.snapshotHash, acknowledgeLowVerifiability: true }).expect(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("a collaborator sees every member but only their own share (decision 6)", async () => {
    const id = await withCollaborator();
    await (await setTeam(id, team70_30(ana))).expect(200);
    const asAna = (await as(ctx, ana).get(`/contracts/${id}`).expect(200)).body as ContractBody;
    expect(asAna.team.map((t) => [t.isSeller, t.shareBps])).toEqual([
      [true, null],
      [false, 3_000],
    ]);
    // The raw snapshot would leak the shares, so a collaborator does not get it.
    expect(JSON.stringify(asAna.currentVersion.snapshot)).not.toContain("7000");
  });
});
