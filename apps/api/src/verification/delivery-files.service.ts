// Delivered .zip files (ADR-0020, hackathon version): checked by content, stored on the server's
// disk under their SHA-256, and served back only as an attachment.
//
// Why the file is named by its hash: the Engine finds it from the hash in the submission and
// checks the bytes again before reading (constitution VII). A name chosen by the seller could
// collide or be swapped; a hash cannot be changed without changing the name.
//
// Why write to a temporary name and rename: rename is atomic on one filesystem, so the Engine
// never opens a half-written file, and a crash leaves a temporary file instead of a corrupt one.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Caller } from "../contracts/contracts.service.js";
import { DB } from "../db/database.js";
import type { Db } from "../db/database.js";
import { deliveryFiles } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { notFound } from "../http/params.js";
import { MilestonesService } from "../payments/milestones.service.js";
import { checkZip, MAX_ZIP_BYTES, ZipRejected } from "./zip-check.js";

export const DELIVERIES_DIR = Symbol("DELIVERIES_DIR");
export const PUBLIC_API_URL = Symbol("PUBLIC_API_URL");

export interface UploadedFile {
  readonly originalname: string;
  readonly buffer: Buffer;
}

export type DeliveryFileRow = typeof deliveryFiles.$inferSelect;

export function fileName(fileHash: string): string {
  return `${fileHash.replace(/^sha256:/, "")}.zip`;
}

// A name for display only: no path, no control characters, at most 200 characters.
function displayName(original: string): string {
  const base = original.replaceAll("\\", "/").split("/").pop() ?? "";
  let clean = "";
  for (const c of base) if ((c.codePointAt(0) ?? 0) >= 0x20 && c !== "\u007f") clean += c;
  clean = clean.trim().slice(0, 200);
  return clean === "" ? "delivery.zip" : clean;
}

@Injectable()
export class DeliveryFilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DELIVERIES_DIR) private readonly dir: string,
    @Inject(PUBLIC_API_URL) private readonly apiUrl: string,
    private readonly milestones: MilestonesService,
  ) {}

  view(row: DeliveryFileRow) {
    return {
      id: row.id,
      milestoneId: row.milestoneId,
      fileHash: row.fileHash,
      name: row.name,
      sizeBytes: row.sizeBytes,
      url: `${this.apiUrl}/milestones/${row.milestoneId}/delivery-files/${row.id}`,
      uploadedAt: row.uploadedAt.toISOString(),
    };
  }

  async upload(milestoneId: string, caller: Caller, file: UploadedFile | undefined) {
    // The seller and the seller's team prepare a delivery; only the seller delivers it (ADR-0020
    // decision 5, hackathon version). A buyer has nothing to upload.
    const role = await this.milestones.partyRoleOf(milestoneId, caller);
    if (role !== "SELLER" && role !== "COLLABORATOR") throw new ProblemException("FORBIDDEN", 403, "Not your step", "Only the seller's team can upload a delivery.");
    if (file === undefined || file.buffer.length === 0) throw new ProblemException("VALIDATION_FAILED", 422, "No file", "Choose a .zip to upload.", { issues: [{ path: "file", message: "required" }] });
    if (file.buffer.length > MAX_ZIP_BYTES) throw new ProblemException("FILE_TOO_LARGE", 413, "The file is too large", "A delivery file can be at most 25 MB.", { maxBytes: MAX_ZIP_BYTES });
    let entryCount: number;
    try {
      entryCount = checkZip(file.buffer).entryCount;
    } catch (error) {
      if (!(error instanceof ZipRejected)) throw error;
      if (error.problem === "NOT_ZIP") throw new ProblemException("FILE_NOT_ZIP", 422, "This is not a .zip", error.reason);
      throw new ProblemException("FILE_UNSAFE", 422, "This .zip cannot be accepted", error.reason, { reason: error.reason });
    }

    const fileHash = `sha256:${createHash("sha256").update(file.buffer).digest("hex")}`;
    await this.store(fileHash, file.buffer);
    const [inserted] = await this.db
      .insert(deliveryFiles)
      .values({ milestoneId, fileHash, name: displayName(file.originalname), sizeBytes: file.buffer.length, entryCount, uploadedBy: caller.user.id })
      .onConflictDoNothing()
      .returning();
    // The same bytes uploaded again for this milestone are the same file: the first row stays.
    const row = inserted ?? (await this.find(milestoneId, fileHash));
    if (row === undefined) throw new Error(`delivery file ${fileHash} vanished after insert`);
    return this.view(row);
  }

  private async store(fileHash: string, data: Buffer): Promise<void> {
    const target = join(this.dir, fileName(fileHash));
    const exists = await stat(target).then(
      () => true,
      () => false,
    );
    if (exists) return; // same hash, same bytes: another milestone or an earlier upload
    await mkdir(this.dir, { recursive: true });
    const temporary = join(this.dir, `.upload-${randomUUID()}`);
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o640 });
      await rename(temporary, target);
      // Read-only once in place: nothing should ever rewrite delivered evidence.
      await chmod(target, 0o440);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async find(milestoneId: string, fileHash: string): Promise<DeliveryFileRow | undefined> {
    const [row] = await this.db.select().from(deliveryFiles).where(and(eq(deliveryFiles.milestoneId, milestoneId), eq(deliveryFiles.fileHash, fileHash)));
    return row;
  }

  // For submitDelivery: a FILE link must name a file uploaded to this milestone.
  async ofMilestone(milestoneId: string, fileHash: string): Promise<DeliveryFileRow | undefined> {
    return this.find(milestoneId, fileHash);
  }

  async download(milestoneId: string, fileId: string, caller: Caller): Promise<{ path: string; row: DeliveryFileRow }> {
    // Parties, and the Reviewer of a dispute on this milestone (ADR-0014).
    if (!(await this.milestones.reviewerMayRead(milestoneId, caller))) await this.milestones.partyRoleOf(milestoneId, caller);
    const [row] = await this.db.select().from(deliveryFiles).where(and(eq(deliveryFiles.milestoneId, milestoneId), eq(deliveryFiles.id, fileId)));
    if (row === undefined) throw notFound();
    return { path: join(this.dir, fileName(row.fileHash)), row };
  }
}
