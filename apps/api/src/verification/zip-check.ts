// Checks an uploaded .zip by its content before Settld keeps it (ADR-0020, hackathon version).
//
// Why read the central directory by hand instead of a ZIP library: nothing is extracted here,
// only the list of entries is needed, and that list is a simple table at the end of the file.
// A library would decompress on request; this cannot, so a bomb has nothing to explode into.
//
// The Engine checks the same limits again before reading (archive.py): the disk is not trusted,
// and a limit enforced in one place only is a limit someone eventually forgets.
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
export const MAX_ENTRIES = 2000;
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_RATIO = 100;
const RATIO_FLOOR_BYTES = 1024 * 1024;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export type ZipProblem = "NOT_ZIP" | "UNSAFE";

export class ZipRejected extends Error {
  constructor(
    readonly problem: ZipProblem,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export interface ZipSummary {
  readonly entryCount: number;
  readonly uncompressedBytes: number;
}

function endOfDirectory(data: Buffer): number {
  // The record is 22 bytes plus a comment of up to 65 535 bytes, so it is near the end.
  const earliest = Math.max(0, data.length - 22 - 0xffff);
  for (let at = data.length - 22; at >= earliest; at--) {
    if (data.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  throw new ZipRejected("NOT_ZIP", "The file is not a ZIP: it has no central directory.");
}

export function checkEntryName(name: string): void {
  const path = name.replaceAll("\\", "/");
  const parts = path.split("/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.includes("..")) {
    throw new ZipRejected("UNSAFE", `Unsafe path in the archive: ${name.slice(0, 200)}`);
  }
}

export function checkZip(data: Buffer): ZipSummary {
  if (data.length < 22) throw new ZipRejected("NOT_ZIP", "The file is not a ZIP.");
  const empty = data.readUInt32LE(0) === END_OF_DIRECTORY;
  if (!empty && data.readUInt32LE(0) !== LOCAL_HEADER) throw new ZipRejected("NOT_ZIP", "The file is not a ZIP: it does not start like one.");

  const eocd = endOfDirectory(data);
  const entries = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryStart = data.readUInt32LE(eocd + 16);
  // ZIP64 marks these 0xFFFF / 0xFFFFFFFF. Nothing under 25 MB needs it, so it is refused rather
  // than half supported.
  if (entries === 0xffff || directoryStart === 0xffffffff || directorySize === 0xffffffff) throw new ZipRejected("UNSAFE", "ZIP64 archives are not accepted.");
  if (entries > MAX_ENTRIES) throw new ZipRejected("UNSAFE", `Too many entries: ${String(entries)} (limit ${String(MAX_ENTRIES)}).`);
  if (directoryStart + directorySize > eocd) throw new ZipRejected("NOT_ZIP", "The ZIP's central directory is damaged.");

  let at = directoryStart;
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > eocd || data.readUInt32LE(at) !== CENTRAL_HEADER) throw new ZipRejected("NOT_ZIP", "The ZIP's central directory is damaged.");
    const uncompressed = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const externalAttributes = data.readUInt32LE(at + 38);
    if (at + 46 + nameLength > eocd) throw new ZipRejected("NOT_ZIP", "The ZIP's central directory is damaged.");
    if (uncompressed === 0xffffffff) throw new ZipRejected("UNSAFE", "ZIP64 archives are not accepted.");
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    checkEntryName(name);
    if (((externalAttributes >>> 16) & S_IFMT) === S_IFLNK) throw new ZipRejected("UNSAFE", `Symbolic link in the archive: ${name.slice(0, 200)}`);
    total += uncompressed;
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (total > MAX_UNCOMPRESSED_BYTES) throw new ZipRejected("UNSAFE", `Too large uncompressed: ${String(total)} bytes.`);
  if (total > RATIO_FLOOR_BYTES && total > MAX_RATIO * data.length) throw new ZipRejected("UNSAFE", `Compression ratio above ${String(MAX_RATIO)}:1.`);
  return { entryCount: entries, uncompressedBytes: total };
}
