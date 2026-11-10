import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { IdentityProfile } from "../auth/identity-provider.js";
import type { AuthenticatedUser, Role, UserDirectory } from "../auth/user-directory.js";
import { DB } from "../db/database.js";
import type { Db } from "../db/database.js";
import { users } from "../db/schema.js";

const AUTH_COLUMNS = { id: users.id, roles: users.roles, onboardingCompletedAt: users.onboardingCompletedAt };

function toAuthenticated(row: { id: string; roles: string[]; onboardingCompletedAt: Date | null }): AuthenticatedUser {
  return { id: row.id, roles: row.roles as Role[], onboarded: row.onboardingCompletedAt !== null };
}

@Injectable()
export class DrizzleUserDirectory implements UserDirectory {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findById(id: string): Promise<AuthenticatedUser | null> {
    const [row] = await this.db.select(AUTH_COLUMNS).from(users).where(eq(users.id, id));
    return row === undefined ? null : toAuthenticated(row);
  }

  async findOrProvision(subject: string, loadProfile: () => Promise<IdentityProfile>): Promise<AuthenticatedUser> {
    // The common case, every request after the first: one indexed read, no call to Clerk.
    const known = await this.byClerkId(subject);
    if (known !== null) return known;

    const profile = await loadProfile();
    // Two first requests can both get here. The unique index on clerk_user_id lets exactly one
    // INSERT win; the loser inserts nothing and reads the winner's row below. Same pattern as
    // the idempotency keys in H1: the database decides, not a check-then-insert in code.
    const [created] = await this.db
      .insert(users)
      .values({ clerkUserId: subject, email: profile.email, displayName: profile.displayName, roles: [] })
      .onConflictDoNothing()
      .returning(AUTH_COLUMNS);
    if (created !== undefined) return toAuthenticated(created);

    const raced = await this.byClerkId(subject);
    if (raced !== null) return raced;

    // The conflict was on email, not on the Clerk id: a row with this email exists under no or
    // another Clerk id (a seeded user, or a Clerk account deleted and created again). Clerk has
    // verified that this person controls the email, so the row is linked to the new subject.
    const [linked] = await this.db.update(users).set({ clerkUserId: subject }).where(eq(users.email, profile.email)).returning(AUTH_COLUMNS);
    if (linked === undefined) throw new Error(`Could not provision Clerk user ${subject}`);
    return toAuthenticated(linked);
  }

  private async byClerkId(subject: string): Promise<AuthenticatedUser | null> {
    const [row] = await this.db.select(AUTH_COLUMNS).from(users).where(eq(users.clerkUserId, subject));
    return row === undefined ? null : toAuthenticated(row);
  }
}
