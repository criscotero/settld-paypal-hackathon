// Port between the AuthGuard and whoever issues session tokens (ADR-0006: Clerk).
// Tests bind a fake, so the guard's rules are tested without signing real JWTs.

export interface IdentityProfile {
  readonly email: string;
  readonly displayName: string;
}

export interface IdentityProvider {
  // The token's subject (Clerk user id) when signature, expiry and authorized party all
  // check out; null otherwise. Never throws for a bad token: a bad token is a 401, not a 500.
  verify(token: string): Promise<string | null>;
  // Read once, when the subject has no User row yet. Session tokens do not carry the email.
  profile(subject: string): Promise<IdentityProfile>;
}

export const IDENTITY_PROVIDER = Symbol("IDENTITY_PROVIDER");

// Used when Clerk is not configured (tests, a local run without keys): every token is invalid,
// so only the dev header can authenticate, and only where ADR-0003 allows it.
export class NoIdentityProvider implements IdentityProvider {
  verify(): Promise<string | null> {
    return Promise.resolve(null);
  }
  profile(): Promise<IdentityProfile> {
    return Promise.reject(new Error("No identity provider configured"));
  }
}
