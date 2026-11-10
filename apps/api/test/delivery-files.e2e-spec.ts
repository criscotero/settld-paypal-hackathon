// ADR-0019 and ADR-0020 (hackathon version): a .zip uploaded to a milestone and a public
// repository fixed at a commit, delivered and passed to the Engine exactly as fixed.
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { approvedContract, as, bootTestApp, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

const HEAD = "d".repeat(40);
const REPO = "https://github.com/acme/site";

// A stored ZIP with one entry, written by hand (see zip-check.spec.ts for the format).
function zipOf(name: string, text: string): Buffer {
  const fileName = Buffer.from(name);
  const data = Buffer.from(text);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const directory = Buffer.concat([central, fileName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(30 + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, directory, end]);
}

interface DeliveryFileBody {
  id: string;
  fileHash: string;
  name: string;
  sizeBytes: number;
  url: string;
}

describe("Delivery files and repositories (ADR-0020)", () => {
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
    ctx.repositories.heads.set(REPO, HEAD);
  });

  const upload = (milestoneId: string, userId: string, data: Buffer, name = "delivery.zip") =>
    request(ctx.app.getHttpServer()).post(`/v1/milestones/${milestoneId}/delivery-files`).set("X-Settld-Dev-User", userId).set("Idempotency-Key", randomUUID()).attach("file", data, name);

  async function started() {
    const { milestoneIds } = await approvedContract(ctx, buyer, seller, draftBody());
    const id = milestoneIds[0] ?? "";
    const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
    const { paypalOrderId } = order.body as { paypalOrderId: string };
    await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId }).expect(200);
    await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
    return id;
  }

  it("stores a .zip under its hash, read-only, and gives the same file for the same bytes", async () => {
    const id = await started();
    const data = zipOf("index.html", "<h1>Pricing</h1>");
    const first = (await upload(id, seller, data).expect(201)).body as DeliveryFileBody;
    const again = (await upload(id, seller, data, "copy.zip").expect(201)).body as DeliveryFileBody;

    const digest = createHash("sha256").update(data).digest("hex");
    expect(first.fileHash).toBe(`sha256:${digest}`);
    expect(again.id).toBe(first.id);
    const onDisk = join(ctx.deliveriesDir, `${digest}.zip`);
    expect(await readFile(onDisk)).toEqual(data);
    expect((await stat(onDisk)).mode & 0o222).toBe(0); // nobody can write it
  });

  it("refuses a file that is not a ZIP, whatever its name", async () => {
    const id = await started();
    const res = await upload(id, seller, Buffer.from("MZ this is a program".padEnd(80)), "delivery.zip").expect(422);
    expect((res.body as { code: string }).code).toBe("FILE_NOT_ZIP");
  });

  it("answers FILE_TOO_LARGE both under and over the upload cap", async () => {
    const id = await started();
    const over = (size: number) => Buffer.concat([zipOf("a.txt", "x"), Buffer.alloc(size)]);
    expect(((await upload(id, seller, over(26 * 1024 * 1024)).expect(413)).body as { code: string }).code).toBe("FILE_TOO_LARGE");
    expect(((await upload(id, seller, over(51 * 1024 * 1024)).expect(413)).body as { code: string }).code).toBe("FILE_TOO_LARGE");
  });

  it("refuses an archive with a path that leaves it", async () => {
    const id = await started();
    const res = await upload(id, seller, zipOf("../../etc/cron.d/x", "boom")).expect(422);
    expect((res.body as { code: string }).code).toBe("FILE_UNSAFE");
  });

  it("lets only the seller's team upload, and hides the milestone from strangers", async () => {
    const id = await started();
    const data = zipOf("a.txt", "hi");
    await upload(id, buyer, data).expect(403);
    await upload(id, await createUser(ctx.db, ["SELLER"]), data).expect(404);
  });

  it("delivers the file and the repository as fixed, and the Engine gets exactly that", async () => {
    const id = await started();
    const file = (await upload(id, seller, zipOf("pricing.md", "Basic, Pro and Team")).expect(201)).body as DeliveryFileBody;
    const res = await as(ctx, seller)
      .post(`/milestones/${id}/submissions`, {
        evidenceLinks: [
          { kind: "FILE", url: "https://anything.example/ignored", fileHash: file.fileHash },
          { kind: "REPOSITORY", url: `${REPO}.git` },
          { kind: "URL", url: "https://example.com/", commitSha: HEAD },
        ],
      })
      .expect(201);
    const links = (res.body as { evidenceLinks: { kind: string; url: string; commitSha?: string; fileHash?: string; label?: string }[] }).evidenceLinks;

    expect(links[0]).toEqual({ kind: "FILE", url: file.url, fileHash: file.fileHash, label: "delivery.zip" });
    expect(links[1]).toEqual({ kind: "REPOSITORY", url: REPO, commitSha: HEAD });
    expect(links[2]).toEqual({ kind: "URL", url: "https://example.com/" }); // a stray commitSha is dropped

    // A push after delivering changes nothing: the submission keeps the commit it was given.
    ctx.repositories.heads.set(REPO, "e".repeat(40));
    const { runId } = res.body as { runId: string };
    await ctx.verification.dispatch(runId);
    const sent = ctx.engine.runs.at(-1);
    expect(sent?.evidenceLinks[1]?.commitSha).toBe(HEAD);
    expect(sent?.evidenceLinks[0]?.fileHash).toBe(file.fileHash);
  });

  it("refuses a file uploaded to another milestone", async () => {
    const mine = await started();
    const other = await started();
    const file = (await upload(other, seller, zipOf("a.txt", "x")).expect(201)).body as DeliveryFileBody;
    const res = await as(ctx, seller).post(`/milestones/${mine}/submissions`, { evidenceLinks: [{ kind: "FILE", url: file.url, fileHash: file.fileHash }] }).expect(422);
    expect((res.body as { code: string }).code).toBe("FILE_UNKNOWN");
  });

  it("refuses a repository GitHub cannot show", async () => {
    const id = await started();
    const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "REPOSITORY", url: "https://github.com/acme/private" }] }).expect(422);
    expect((res.body as { code: string }).code).toBe("REPOSITORY_UNREADABLE");
  });

  it("serves the file to the buyer only as an attachment", async () => {
    const id = await started();
    const data = zipOf("index.html", "<script>alert(1)</script>");
    const file = (await upload(id, seller, data).expect(201)).body as DeliveryFileBody;
    const res = await request(ctx.app.getHttpServer()).get(`/v1/milestones/${id}/delivery-files/${file.id}`).set("X-Settld-Dev-User", buyer).buffer(true).expect(200);

    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    await request(ctx.app.getHttpServer()).get(`/v1/milestones/${id}/delivery-files/${file.id}`).set("X-Settld-Dev-User", await createUser(ctx.db, ["BUYER"])).expect(404);
  });
});
