// Everything Core API reads from the environment, validated once at startup (fail fast).
import { loadAuthConfig } from "./auth/auth-config.js";
import type { AuthConfig } from "./auth/auth-config.js";

export interface AppConfig {
  readonly databaseUrl: string;
  // Frozen into each contract version (ADR-0004, H1-G4: 0 in the MVP).
  readonly platformFeeBps: number;
  // Where apps/web lives, for links Core API hands out (invitations, ADR-0005).
  readonly webUrl: string;
  readonly auth: AuthConfig;
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env): AppConfig {
  const databaseUrl = env.CORE_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("CORE_DATABASE_URL is not set (see .env.example)");
  }
  const fee = Number(env.PLATFORM_FEE_BPS ?? "0");
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) {
    throw new Error(`PLATFORM_FEE_BPS must be an integer between 0 and 10000, got ${String(env.PLATFORM_FEE_BPS)}`);
  }
  const webUrl = env.SETTLD_WEB_URL ?? "http://localhost:3000";
  if (!URL.canParse(webUrl)) throw new Error(`SETTLD_WEB_URL must be a URL, got ${JSON.stringify(webUrl)}`);
  return { databaseUrl, platformFeeBps: fee, webUrl: webUrl.replace(/\/$/, ""), auth: loadAuthConfig(env) };
}

export const APP_CONFIG = Symbol("APP_CONFIG");
