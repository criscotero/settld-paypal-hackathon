import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// One .env at the repo root for every app. Loaded here instead of `node --env-file` in the
// dev script: Next 16 copies the parent's flags into NODE_OPTIONS for its workers, and Node
// refuses --env-file there. Variables already set (CI, a hosting provider) win over the file.
const rootEnv = new URL("../../.env", import.meta.url).pathname;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  reactStrictMode: true,
  // The demo is served through an ngrok https tunnel, because Log in with PayPal only returns
  // to an address registered in the PayPal app and PayPal refused http://localhost. Without
  // this, Next's dev server refuses its own scripts and hot reload to that origin.
  allowedDevOrigins: ["*.ngrok-free.dev"],
  experimental: {
    // A delivery can carry a .zip of up to 25 MB (ADR-0020), and it goes through the delivery's
    // server action so the session token never reaches the browser (ADR-0005). The default is
    // 1 MB. On Vercel the platform still caps a request at about 4.5 MB, whatever this says.
    serverActions: { bodySizeLimit: "26mb" },
  },
};

export default config;
