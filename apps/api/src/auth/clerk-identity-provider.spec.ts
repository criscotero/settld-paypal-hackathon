import { createSign, generateKeyPairSync } from "node:crypto";
import { ClerkIdentityProvider } from "./clerk-identity-provider.js";

// Real JWTs, signed here with a throwaway RSA key and verified networkless through `jwtKey`:
// this exercises the actual @clerk/backend verifyToken, which a fake provider cannot. It is
// what caught verifyToken throwing instead of returning { data, errors }.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const WEB = "http://localhost:3000";

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(claims: Record<string, unknown>, key = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now, nbf: now - 5, exp: now + 60, ...claims })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
  return `${unsigned}.${signature}`;
}

const provider = new ClerkIdentityProvider({ secretKey: "sk_test_unused", jwtKey: PUBLIC_PEM, authorizedParties: [WEB] });

describe("ClerkIdentityProvider.verify (ADR-0006)", () => {
  it("returns the subject of a valid token from the web app", async () => {
    await expect(provider.verify(jwt({ sub: "user_123", azp: WEB }))).resolves.toBe("user_123");
  });

  it("returns null, not an exception, for an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(provider.verify(jwt({ sub: "user_123", azp: WEB, iat: past, nbf: past, exp: past + 60 }))).resolves.toBeNull();
  });

  it("refuses a token minted for another site (azp)", async () => {
    await expect(provider.verify(jwt({ sub: "user_123", azp: "https://evil.example" }))).resolves.toBeNull();
  });

  it("refuses a token signed with a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(provider.verify(jwt({ sub: "user_123", azp: WEB }, other))).resolves.toBeNull();
  });

  it("refuses garbage", async () => {
    await expect(provider.verify("not.a.jwt")).resolves.toBeNull();
  });
});
