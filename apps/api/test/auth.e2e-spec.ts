import { Controller, Get, UseGuards } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { AuthModule } from "../src/auth/auth.module.js";
import { CurrentUser } from "../src/auth/current-user.decorator.js";
import type { IdentityProfile, IdentityProvider } from "../src/auth/identity-provider.js";
import { IDENTITY_PROVIDER } from "../src/auth/identity-provider.js";
import type { AuthenticatedUser, UserDirectory } from "../src/auth/user-directory.js";
import { USER_DIRECTORY } from "../src/auth/user-directory.js";
import { ProblemFilter } from "../src/errors/problem.filter.js";

const CLIENT_ID = "6f1c2b8e-2d4a-4b7e-9a51-0c3d7e9f1a20";
const UNKNOWN_ID = "0b9e4c1d-8f2a-4e3b-a6c5-d7e8f9a0b1c2";

// Stands in for the `User` table (Drizzle), so these tests need no database.
class InMemoryUserDirectory implements UserDirectory {
  readonly provisioned: string[] = [];
  private readonly bySubject = new Map<string, AuthenticatedUser>();

  constructor(private readonly users: AuthenticatedUser[]) {}

  findById(id: string): Promise<AuthenticatedUser | null> {
    return Promise.resolve(this.users.find((u) => u.id === id) ?? null);
  }

  async findOrProvision(subject: string, loadProfile: () => Promise<IdentityProfile>): Promise<AuthenticatedUser> {
    const known = this.bySubject.get(subject);
    if (known !== undefined) return known;
    await loadProfile();
    const user = this.bySubject.get(subject) ?? { id: `user-for-${subject}`, roles: [], onboarded: false };
    if (!this.bySubject.has(subject)) this.provisioned.push(subject);
    this.bySubject.set(subject, user);
    return user;
  }
}

// Accepts "valid-<subject>" and nothing else: the guard's rules without real JWTs.
class FakeIdentityProvider implements IdentityProvider {
  profileCalls = 0;
  verify(token: string): Promise<string | null> {
    return Promise.resolve(token.startsWith("valid-") ? token.slice("valid-".length) : null);
  }
  profile(): Promise<IdentityProfile> {
    this.profileCalls += 1;
    return Promise.resolve({ email: "new@example.com", displayName: "New Person" });
  }
}

// Test-only route: the contract's GET /me needs the full User (H1).
@Controller("probe")
@UseGuards(AuthGuard)
class ProbeController {
  @Get()
  whoAmI(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}

let directory: InMemoryUserDirectory;
let identity: FakeIdentityProvider;

async function bootApp(env: NodeJS.ProcessEnv): Promise<INestApplication<App>> {
  directory = new InMemoryUserDirectory([{ id: CLIENT_ID, roles: ["BUYER"], onboarded: true }]);
  identity = new FakeIdentityProvider();
  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule.forRoot(env)],
    controllers: [ProbeController],
  })
    .overrideProvider(USER_DIRECTORY)
    .useValue(directory)
    .overrideProvider(IDENTITY_PROVIDER)
    .useValue(identity)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  return app;
}

describe("Dev auth header (ADR-0001)", () => {
  let app: INestApplication<App> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function http(): ReturnType<typeof request> {
    if (app === undefined) throw new Error("boot the app first");
    return request(app.getHttpServer());
  }

  it.each([{ NODE_ENV: "production" }, {}])(
    "refuses to boot with SETTLD_DEV_AUTH=true and %j",
    async (env) => {
      await expect(bootApp({ ...env, SETTLD_DEV_AUTH: "true" })).rejects.toThrow(/SETTLD_DEV_AUTH/);
    },
  );

  describe("with dev auth on", () => {
    beforeEach(async () => {
      app = await bootApp({ NODE_ENV: "test", SETTLD_DEV_AUTH: "true" });
    });

    it("authenticates a known user and takes roles from the directory, not the header", async () => {
      const res = await http()
        .get("/probe")
        .set("X-Settld-Dev-User", CLIENT_ID)
        .expect(200);
      expect(res.body).toEqual({ id: CLIENT_ID, roles: ["BUYER"], onboarded: true });
    });

    it.each([
      ["an unknown user", UNKNOWN_ID],
      ["a value that is not a UUID", "admin"],
    ])("answers 401 UNAUTHENTICATED for %s", async (_label, header) => {
      const res = await http()
        .get("/probe")
        .set("X-Settld-Dev-User", header)
        .expect(401)
        .expect("Content-Type", /application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
      expect(res.body).toHaveProperty("requestId");
    });

    it("answers 401 when the header is sent twice", async () => {
      // Node joins a repeated header into one value with ", ": this is what the guard sees.
      const res = await http()
        .get("/probe")
        .set("X-Settld-Dev-User", `${CLIENT_ID}, ${UNKNOWN_ID}`)
        .expect(401);
      expect(res.body).toMatchObject({ code: "UNAUTHENTICATED" });
    });

    it("answers 401 without the header", async () => {
      const res = await http().get("/probe").expect(401);
      expect(res.body).toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });

  describe("with dev auth off", () => {
    it("ignores the header and answers 401 UNAUTHENTICATED", async () => {
      app = await bootApp({});
      const res = await http()
        .get("/probe")
        .set("X-Settld-Dev-User", CLIENT_ID)
        .expect(401);
      expect(res.body).toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });

  describe("Clerk session token (ADR-0006)", () => {
    beforeEach(async () => {
      app = await bootApp({ NODE_ENV: "test", SETTLD_DEV_AUTH: "true" });
    });

    it("creates the user on its first request and reuses it afterwards", async () => {
      const first = await http().get("/probe").set("Authorization", "Bearer valid-user_1").expect(200);
      const second = await http().get("/probe").set("Authorization", "Bearer valid-user_1").expect(200);
      expect(first.body).toEqual({ id: "user-for-user_1", roles: [], onboarded: false });
      expect(second.body).toEqual(first.body);
      expect(directory.provisioned).toEqual(["user_1"]);
      // Clerk's API is asked for the email once, on creation; not on every request.
      expect(identity.profileCalls).toBe(1);
    });

    it("answers 401 for a token the provider rejects", async () => {
      const res = await http().get("/probe").set("Authorization", "Bearer forged").expect(401);
      expect(res.body).toMatchObject({ code: "UNAUTHENTICATED" });
    });

    it("answers 401 for an Authorization header that is not a Bearer token", async () => {
      await http().get("/probe").set("Authorization", "Basic dXNlcjpwYXNz").expect(401);
    });

    it("never falls back to the dev header when a bad token is sent", async () => {
      // One request, one identity: a rejected token plus a valid dev header is still a 401.
      await http().get("/probe").set("Authorization", "Bearer forged").set("X-Settld-Dev-User", CLIENT_ID).expect(401);
    });
  });

  it("echoes X-Request-Id into the problem body", async () => {
    app = await bootApp({});
    const res = await http()
      .get("/probe")
      .set("X-Request-Id", "req_test_1")
      .expect(401);
    expect(res.body).toMatchObject({ requestId: "req_test_1" });
  });
});
