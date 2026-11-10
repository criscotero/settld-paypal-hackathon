import { z } from "zod";

// Keyset pagination over (timestamp, id): stable while rows keep arriving, unlike an offset. Opaque to
// clients, so the sort can change without breaking the contract. A cursor that does not decode is
// treated as none: an old link shows the first page rather than an error.
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !z.uuid().safeParse(id).success) return null;
  return { at: new Date(at), id };
}
