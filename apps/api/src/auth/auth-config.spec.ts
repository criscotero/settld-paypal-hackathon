import { DevAuthNotAllowedError, loadAuthConfig } from "./auth-config.js";

describe("loadAuthConfig (ADR-0001, ADR-0003)", () => {
  it.each(["development", "test"])("enables dev auth with NODE_ENV=%s", (nodeEnv) => {
    expect(loadAuthConfig({ NODE_ENV: nodeEnv, SETTLD_DEV_AUTH: "true" })).toEqual({ devAuthEnabled: true, clerk: null });
  });

  // Allowlist, not denylist: any environment that is not explicitly dev or test
  // is treated as production, including a missing or misspelled NODE_ENV.
  it.each([
    ["production", "production"],
    ["unset", undefined],
    ["empty", ""],
    ["misspelled", "prod"],
    ["staging", "staging"],
    ["wrong case", "Development"],
  ])("refuses dev auth when NODE_ENV is %s", (_label, nodeEnv) => {
    expect(() => loadAuthConfig({ NODE_ENV: nodeEnv, SETTLD_DEV_AUTH: "true" })).toThrow(
      DevAuthNotAllowedError,
    );
  });

  // A typo like "1" or "TRUE" must not silently turn impersonation on, and must not
  // silently leave it off either: the developer would get confusing 401s.
  it.each(["1", "TRUE", "yes", " true"])("rejects ambiguous value %j", (value) => {
    expect(() => loadAuthConfig({ NODE_ENV: "development", SETTLD_DEV_AUTH: value })).toThrow(
      /SETTLD_DEV_AUTH/,
    );
  });

  it.each([{}, { SETTLD_DEV_AUTH: "false" }, { SETTLD_DEV_AUTH: "" }])(
    "keeps dev auth off for %j",
    (env) => {
      expect(loadAuthConfig(env)).toEqual({ devAuthEnabled: false, clerk: null });
    },
  );

  it("allows any NODE_ENV when dev auth is off", () => {
    expect(loadAuthConfig({ NODE_ENV: "production" })).toEqual({ devAuthEnabled: false, clerk: null });
    expect(loadAuthConfig({})).toEqual({ devAuthEnabled: false, clerk: null });
  });

  describe("Clerk (ADR-0006)", () => {
    it("trusts tokens minted for the web app only", () => {
      const config = loadAuthConfig({ CLERK_SECRET_KEY: "sk_test_abc", SETTLD_WEB_URL: "https://app.settld.example/" });
      expect(config.clerk).toEqual({ secretKey: "sk_test_abc", jwtKey: undefined, authorizedParties: ["https://app.settld.example"] });
    });

    it("refuses a publishable key pasted where the secret key goes", () => {
      expect(() => loadAuthConfig({ CLERK_SECRET_KEY: "pk_test_abc" })).toThrow(/CLERK_SECRET_KEY/);
    });
  });
});
