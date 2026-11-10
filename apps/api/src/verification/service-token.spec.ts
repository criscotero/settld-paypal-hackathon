// Service tokens between Core API and the Engine (service-boundaries.md section 3): the claims
// half, without the database. The jti replay check is covered by the e2e test of the events
// endpoint, where the table is real.
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { checkServiceToken, loadServiceKeys, signServiceToken } from "./service-token.js";
import type { ServiceKeys } from "./service-token.js";

const core = generateKeyPairSync("ed25519");
const engine = generateKeyPairSync("ed25519");
const keys: ServiceKeys = { signing: core.privateKey, peer: engine.publicKey };

async function engineToken(claims: Record<string, unknown> = {}, key = engine.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const all = { iss: "settld-engine", aud: "settld-core", iat: now, exp: now + 60, jti: crypto.randomUUID(), ...claims };
  // An override of undefined drops that claim.
  const payload = Object.fromEntries(Object.entries(all).filter(([, v]) => (v as unknown) !== undefined));
  return new SignJWT(payload).setProtectedHeader({ alg: "EdDSA" }).sign(key);
}

describe("service tokens", () => {
  it("accepts a token the Engine signed for Core", async () => {
    const claims = await checkServiceToken(keys, `Bearer ${await engineToken()}`);
    expect(claims.jti).toBeTypeOf("string");
  });

  it.each([
    ["no header", () => Promise.resolve(undefined)],
    ["not bearer", async () => `Basic ${await engineToken()}`],
    ["expired", async () => `Bearer ${await engineToken({ iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 })}`],
    ["meant for the Engine", async () => `Bearer ${await engineToken({ aud: "settld-engine" })}`],
    ["not issued by the Engine", async () => `Bearer ${await engineToken({ iss: "settld-core" })}`],
    ["someone else's key", async () => `Bearer ${await engineToken({}, generateKeyPairSync("ed25519").privateKey)}`],
    ["Core's own key", async () => `Bearer ${await engineToken({}, core.privateKey)}`],
    ["no jti", async () => `Bearer ${await engineToken({ jti: undefined })}`],
    ["lives longer than 60 s", async () => `Bearer ${await engineToken({ exp: Math.floor(Date.now() / 1000) + 3600 })}`],
  ])("refuses %s", async (_name, header) => {
    await expect(checkServiceToken(keys, await header())).rejects.toThrow();
  });

  it("signs tokens the Engine can verify: Core to Engine, 60 s, a fresh jti each time", async () => {
    const { jwtVerify } = await import("jose");
    const a = await jwtVerify(await signServiceToken(keys), core.publicKey, { algorithms: ["EdDSA"], audience: "settld-engine", issuer: "settld-core" });
    const b = await jwtVerify(await signServiceToken(keys), core.publicKey, { algorithms: ["EdDSA"] });
    expect((a.payload.exp ?? 0) - (a.payload.iat ?? 0)).toBe(60);
    expect(a.payload.jti).not.toBe(b.payload.jti);
  });

  it("loads keys from one-line base64 DER, and refuses half a configuration", () => {
    const env = {
      CORE_SERVICE_PRIVATE_KEY: core.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      ENGINE_SERVICE_PUBLIC_KEY: engine.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    };
    expect(loadServiceKeys(env)?.signing.asymmetricKeyType).toBe("ed25519");
    expect(loadServiceKeys({ CORE_SERVICE_PRIVATE_KEY: env.CORE_SERVICE_PRIVATE_KEY })).toBeNull();
  });
});
