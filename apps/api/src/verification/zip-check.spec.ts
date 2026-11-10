// ADR-0020: a .zip is accepted only by its content and inside its limits.
import { describe, expect, it } from "vitest";
import { checkZip, MAX_ENTRIES, ZipRejected } from "./zip-check.js";

interface Entry {
  name: string;
  data?: Buffer;
  // What the central directory claims, which is all checkZip reads: a crafted archive can claim anything.
  uncompressed?: number;
  mode?: number;
}

// A stored (uncompressed) ZIP, written by hand so tests can craft hostile headers.
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.uncompressed ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function rejected(data: Buffer): ZipRejected {
  try {
    checkZip(data);
  } catch (error) {
    if (error instanceof ZipRejected) return error;
    throw error;
  }
  throw new Error("expected the archive to be rejected");
}

describe("checkZip", () => {
  it("accepts a normal archive and counts its entries", () => {
    const summary = checkZip(zip([{ name: "index.html", data: Buffer.from("<h1>Hi</h1>") }, { name: "src/" }, { name: "src/app.ts", data: Buffer.from("export {}") }]));
    expect(summary).toEqual({ entryCount: 3, uncompressedBytes: 20 });
  });

  it("accepts an empty archive", () => {
    expect(checkZip(zip([])).entryCount).toBe(0);
  });

  it("refuses a file that is not a ZIP, whatever it is called", () => {
    expect(rejected(Buffer.from("MZ\x90\x00 this is a Windows program, renamed delivery.zip".padEnd(64))).problem).toBe("NOT_ZIP");
    expect(rejected(Buffer.from("tiny")).problem).toBe("NOT_ZIP");
  });

  it("refuses a ZIP whose directory is cut off", () => {
    const whole = zip([{ name: "a.txt", data: Buffer.from("hello") }]);
    expect(rejected(whole.subarray(0, whole.length - 30)).problem).toBe("NOT_ZIP");
  });

  it.each(["../evil.sh", "/etc/passwd", "a/../../b", "C:/Windows/win.ini", "..\\up.txt"])("refuses the path %s", (name) => {
    const error = rejected(zip([{ name }]));
    expect(error.problem).toBe("UNSAFE");
    expect(error.reason).toMatch(/path/);
  });

  it("refuses a symbolic link", () => {
    expect(rejected(zip([{ name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }])).reason).toMatch(/link/);
  });

  it("refuses an archive that claims too much uncompressed data", () => {
    expect(rejected(zip([{ name: "big.bin", uncompressed: 250 * 1024 * 1024 }])).reason).toMatch(/uncompressed/);
  });

  it("refuses a bomb by its ratio", () => {
    expect(rejected(zip([{ name: "zeros.bin", data: Buffer.alloc(100), uncompressed: 50 * 1024 * 1024 }])).reason).toMatch(/ratio/);
  });

  it("refuses too many entries", () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${String(i)}.txt` }));
    expect(rejected(zip(many)).reason).toMatch(/entries/);
  });

  it("refuses ZIP64", () => {
    expect(rejected(zip([{ name: "a", uncompressed: 0xffffffff }])).reason).toMatch(/ZIP64/);
  });
});
