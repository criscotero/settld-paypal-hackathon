// ADR-0001, ADR-0003: the dev auth header exists only when the process starts in dev mode.

export interface AuthConfig {
  readonly devAuthEnabled: boolean;
  // Null when CLERK_SECRET_KEY is unset: Bearer tokens are then always refused (ADR-0006).
  readonly clerk: ClerkConfig | null;
}

export interface ClerkConfig {
  readonly secretKey: string;
  // Optional PEM public key: verifies tokens without fetching Clerk's keys over the network.
  readonly jwtKey: string | undefined;
  // Origins allowed in the token's `azp` claim: the web app, nothing else.
  readonly authorizedParties: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

// ADR-0003: an allowlist. A denylist ("not production") lets an unset or misspelled
// NODE_ENV through, and that is exactly how a real deploy goes wrong.
const DEV_AUTH_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "test"]);

export class DevAuthNotAllowedError extends Error {
  constructor(nodeEnv: string | undefined) {
    super(
      `SETTLD_DEV_AUTH=true requires NODE_ENV=development or test, got ${JSON.stringify(nodeEnv ?? null)}. ` +
        "Anywhere else it would let anyone act as any user. Set NODE_ENV, or remove SETTLD_DEV_AUTH.",
    );
    this.name = "DevAuthNotAllowedError";
  }
}

// Throws instead of returning a flag so that the caller cannot "forget" to check:
// the only way to get an AuthConfig is through this function, and outside dev/test
// with dev auth on there is no AuthConfig to get. The process dies before it listens.
export function loadAuthConfig(env: Env): AuthConfig {
  const raw = env.SETTLD_DEV_AUTH;

  // Strict parsing: "1" or "TRUE" would otherwise be read as off, and the developer
  // would chase 401s; read as on, a typo in a prod template becomes impersonation.
  if (raw !== undefined && raw !== "" && raw !== "true" && raw !== "false") {
    throw new Error(`SETTLD_DEV_AUTH must be "true" or "false", got ${JSON.stringify(raw)}`);
  }
  const devAuthEnabled = raw === "true";

  if (devAuthEnabled && !DEV_AUTH_ENVIRONMENTS.has(env.NODE_ENV ?? "")) {
    throw new DevAuthNotAllowedError(env.NODE_ENV);
  }
  return { devAuthEnabled, clerk: loadClerkConfig(env) };
}

function loadClerkConfig(env: Env): ClerkConfig | null {
  const secretKey = env.CLERK_SECRET_KEY;
  if (secretKey === undefined || secretKey === "") return null;
  // A publishable key here is the classic copy-paste mistake; it would fail every request.
  if (!secretKey.startsWith("sk_")) throw new Error("CLERK_SECRET_KEY must be a Clerk secret key (sk_test_… or sk_live_…)");
  const webUrl = (env.SETTLD_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const jwtKey = env.CLERK_JWT_KEY === undefined || env.CLERK_JWT_KEY === "" ? undefined : env.CLERK_JWT_KEY;
  return { secretKey, jwtKey, authorizedParties: [webUrl] };
}
