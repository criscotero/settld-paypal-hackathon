// Service tokens between Core API and the Engine (service-boundaries.md section 3, SB-7,
// ADR-0008 decision 2): a JWT signed with Ed25519 that lives 60 seconds. The Engine's twin is
// apps/engine/src/settld_engine/service_auth.py; the two must agree on every claim.
//
// Asymmetric on purpose: Core holds its private key and the Engine's public key, nothing else.
// A leak of the Engine's secrets lets someone sign as the Engine, never as Core.
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { serviceTokenJti } from "../db/schema.js";

const CORE = "settld-core";
const ENGINE = "settld-engine";
const LIFETIME_SECONDS = 60;
// Two machines' clocks never agree exactly; a few seconds keeps a token signed "in the future"
// from failing at random without stretching its life in any real way.
const LEEWAY_SECONDS = 5;

export interface ServiceKeys {
  readonly signing: KeyObject; // Core's own private key: signs calls to the Engine
  readonly peer: KeyObject; // the Engine's public key: verifies calls from the Engine
}

export interface ServiceClaims {
  readonly jti: string;
  readonly exp: number;
}

export const SERVICE_KEYS = Symbol("SERVICE_KEYS");

// One-line base64 DER (PKCS#8 private, SPKI public), safe in a .env file. null when either is
// missing: the bridge then refuses every call instead of accepting unsigned ones.
export function loadServiceKeys(env: Readonly<Record<string, string | undefined>>): ServiceKeys | null {
  const priv = env.CORE_SERVICE_PRIVATE_KEY;
  const pub = env.ENGINE_SERVICE_PUBLIC_KEY;
  if (priv === undefined || priv === "" || pub === undefined || pub === "") return null;
  const signing = createPrivateKey({ key: Buffer.from(priv, "base64"), format: "der", type: "pkcs8" });
  const peer = createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
  if (signing.asymmetricKeyType !== "ed25519" || peer.asymmetricKeyType !== "ed25519") throw new Error("Service keys must be Ed25519");
  return { signing, peer };
}

// A fresh token for one call. Never reuse it: the Engine refuses a jti it has seen.
export async function signServiceToken(keys: ServiceKeys): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "EdDSA" }).setIssuer(CORE).setAudience(ENGINE).setIssuedAt(now).setExpirationTime(now + LIFETIME_SECONDS).setJti(randomUUID()).sign(keys.signing);
}

// The claims half of the check. Throws on any doubt.
export async function checkServiceToken(keys: ServiceKeys, authorization: string | undefined): Promise<ServiceClaims> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (token === undefined) throw new Error("missing bearer token");
  // algorithms is fixed: trusting the token's own "alg" is how "alg: none" attacks work.
  const { payload } = await jwtVerify(token, keys.peer, { algorithms: ["EdDSA"], audience: CORE, issuer: ENGINE, clockTolerance: LEEWAY_SECONDS, requiredClaims: ["iat", "exp", "jti"] });
  const { iat = 0, exp = 0, jti = "" } = payload;
  // A signed token claiming a longer life is still refused: the replay window is only as short
  // as the longest token anyone accepts.
  if (exp - iat > LIFETIME_SECONDS) throw new Error("token lives longer than 60 s");
  return { jti, exp };
}

// The replay half. A valid token stays valid for 60 s; whoever reads one from a log or a proxy
// could resend the same call in that window. The jti's primary key makes the second use fail,
// decided by Postgres even across Core instances. Rows only matter until the token expires.
export async function recordJti(db: Db, claims: ServiceClaims): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.delete(serviceTokenJti).where(lt(serviceTokenJti.expiresAt, sql`now()`));
    const inserted = await tx
      .insert(serviceTokenJti)
      .values({ jti: claims.jti, expiresAt: new Date((claims.exp + LEEWAY_SECONDS) * 1000) })
      .onConflictDoNothing()
      .returning({ jti: serviceTokenJti.jti });
    return inserted.length === 1;
  });
}
