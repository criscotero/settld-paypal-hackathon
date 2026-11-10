// The collaborator directory (ADR-0009, openapi.yaml: searchDirectory). Constitution XI: only
// people who opted in appear, and never with their email. Only people who can actually be
// paid are listed, so a seller never builds a team PayPal will refuse (PAYEE_NOT_CONSENTED).
import { Controller, Get, Inject, Injectable, Query } from "@nestjs/common";
import { and, arrayContains, arrayOverlaps, desc, eq, ilike, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../db/database.js";
import type { Db } from "../db/database.js";
import { PROFESSIONS, users } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../http/keyset-cursor.js";
import { parsedOrThrow } from "../http/validation.js";

const PAGE_SIZE = 20;

const query = z.object({
  // 254: the longest email address. A name search stays short in practice.
  q: z.string().trim().max(254).optional(),
  profession: z.enum(PROFESSIONS).optional(),
  cursor: z.string().max(200).optional(),
});

// LIKE treats % and _ as wildcards; a search for "50%" must not match everything.
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class DirectoryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async search(input: z.output<typeof query>) {
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const q = input.q === undefined || input.q === "" ? null : input.q;
    // An address finds only its exact owner (openapi 0.17.0), never by a fragment: "@gmail" or
    // "ana@" must find nobody, or the directory would leak which addresses exist. The email is
    // compared, never returned.
    const email = q !== null && q.includes("@") ? q.toLowerCase() : null;
    const pattern = q === null || email !== null ? null : likePattern(q);
    const rows = await this.db
      .select({ id: users.id, displayName: users.displayName, headline: users.headline, professions: users.professions, skills: users.skills, country: users.country, at: users.professionalUpdatedAt })
      .from(users)
      .where(
        and(
          eq(users.inDirectory, true),
          isNotNull(users.onboardingCompletedAt),
          isNotNull(users.paypalMerchantId),
          eq(users.paypalPaymentsReceivable, true),
          isNotNull(users.professionalUpdatedAt),
          arrayOverlaps(users.roles, ["SELLER", "COLLABORATOR"]),
          input.profession === undefined ? undefined : arrayContains(users.professions, [input.profession]),
          pattern === null ? undefined : or(ilike(users.displayName, pattern), ilike(users.headline, pattern), sql`array_to_string(${users.skills}, ' ') ILIKE ${pattern}`),
          email === null ? undefined : sql`lower(${users.email}) = ${email}`,
          cursor === null ? undefined : or(lt(users.professionalUpdatedAt, cursor.at), and(eq(users.professionalUpdatedAt, cursor.at), lt(users.id, cursor.id))),
        ),
      )
      .orderBy(desc(users.professionalUpdatedAt), desc(users.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({ userId: r.id, displayName: r.displayName, headline: r.headline, professions: r.professions, skills: r.skills, country: r.country })),
      nextCursor: rows.length > PAGE_SIZE && last?.at != null ? encodeCursor(last.at, last.id) : null,
    };
  }
}

@Controller("directory")
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  search(@Query() q: unknown) {
    return this.directory.search(parsedOrThrow(query.safeParse(q)));
  }
}
