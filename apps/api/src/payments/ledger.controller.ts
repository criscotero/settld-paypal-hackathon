// Thin HTTP layer for listPayments (openapi.yaml, ADR-0017).
import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { parsedOrThrow } from "../http/validation.js";
import { LedgerService } from "./ledger.service.js";

// z.iso.date also refuses dates that do not exist, like 2026-02-31. A loose regex would let those
// through to `new Date`, which rolls them into March without saying anything.
// The bounds keep both ends real to Postgres: it has no year 0, and the service reads up to the day
// after `to`, which past 9999-12-31 has no four-digit year. Without them those dates answer 500.
const MIN_DAY = "1000-01-01";
const MAX_DAY = "9998-12-31";
const range = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((r) => r.from >= MIN_DAY, { path: ["from"], message: `must not be before ${MIN_DAY}` })
  .refine((r) => r.to <= MAX_DAY, { path: ["to"], message: `must not be after ${MAX_DAY}` })
  .refine((r) => r.from <= r.to, { path: ["to"], message: "must not be before from" });

@Controller()
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get("payments")
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const { from, to } = parsedOrThrow(range.safeParse(query));
    return this.ledger.list(user.id, from, to);
  }
}
