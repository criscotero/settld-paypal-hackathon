// Generates the two Ed25519 key pairs of the Core <-> Engine bridge (service-boundaries.md,
// section 3) and prints them as .env lines. Run: node scripts/gen-service-keys.mjs >> .env
//
// Locally both services read the same .env, so this one file holds both private keys. In AWS
// each service's task role sees only its own private key and the other's public key (SB-8).
import { generateKeyPairSync } from "node:crypto";

const pair = () => generateKeyPairSync("ed25519");
const priv = (k) => k.export({ format: "der", type: "pkcs8" }).toString("base64");
const pub = (k) => k.export({ format: "der", type: "spki" }).toString("base64");
const core = pair();
const engine = pair();

console.log(`CORE_SERVICE_PRIVATE_KEY=${priv(core.privateKey)}`);
console.log(`CORE_SERVICE_PUBLIC_KEY=${pub(core.publicKey)}`);
console.log(`ENGINE_SERVICE_PRIVATE_KEY=${priv(engine.privateKey)}`);
console.log(`ENGINE_SERVICE_PUBLIC_KEY=${pub(engine.publicKey)}`);
