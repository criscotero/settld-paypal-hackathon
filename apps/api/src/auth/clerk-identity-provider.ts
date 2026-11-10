import { createClerkClient, verifyToken } from "@clerk/backend";
import type { ClerkConfig } from "./auth-config.js";
import type { IdentityProfile, IdentityProvider } from "./identity-provider.js";

// ADR-0006. verifyToken checks the signature against Clerk's public keys (fetched once and
// cached by the SDK, or none at all with CLERK_JWT_KEY), the expiry, and `azp`: a token minted
// for some other site that also uses Clerk is refused even though its signature is valid.
export class ClerkIdentityProvider implements IdentityProvider {
  private readonly client;

  constructor(private readonly config: ClerkConfig) {
    this.client = createClerkClient({ secretKey: config.secretKey });
  }

  async verify(token: string): Promise<string | null> {
    // The package's public verifyToken returns the payload and THROWS on a bad token (the
    // internal one returns { data, errors }). Its JwtPayload type has an index signature, so
    // reading `.errors` on it type-checks as `unknown`: the compiler cannot catch the mix-up.
    let payload: Awaited<ReturnType<typeof verifyToken>>;
    try {
      payload = await verifyToken(token, {
        secretKey: this.config.secretKey,
        ...(this.config.jwtKey === undefined ? {} : { jwtKey: this.config.jwtKey }),
        authorizedParties: [...this.config.authorizedParties],
      });
    } catch {
      return null;
    }
    return typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
  }

  async profile(subject: string): Promise<IdentityProfile> {
    const user = await this.client.users.getUser(subject);
    const email = user.primaryEmailAddress?.emailAddress;
    // Clerk verifies the email before a session exists; no email means a sign-up method we
    // did not enable (phone only), and Settld needs one for contracts and receipts.
    if (email === undefined) throw new Error(`Clerk user ${subject} has no primary email`);
    return { email: email.toLowerCase(), displayName: user.fullName ?? email.split("@")[0] ?? email };
  }
}
