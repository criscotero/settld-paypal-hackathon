import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { AppModule } from "../../src/app.module.js";
import { createDb, createPool } from "../../src/db/database.js";
import type { Db } from "../../src/db/database.js";
import { users } from "../../src/db/schema.js";
import { INVITATION_SENDER } from "../../src/contracts/invitations.service.js";
import type { InvitationSender } from "../../src/contracts/invitations.service.js";
import { configureApp } from "../../src/http/configure-app.js";
import { CLOCK } from "../../src/payments/clock.js";
import type { Clock } from "../../src/payments/clock.js";
import { FakePaymentProvider } from "../../src/payments/fake-payment-provider.js";
import { JOB_SCHEDULER } from "../../src/payments/job-scheduler.js";
import { MemoryJobScheduler } from "../../src/payments/memory-job-scheduler.js";
import { MilestonesService } from "../../src/payments/milestones.service.js";
import { PAYMENT_PROVIDER } from "../../src/payments/payment-provider.js";
import type { LinkedPaypalAccount, PaypalAccounts, SellerStatus } from "../../src/payments/paypal-accounts.js";
import { PAYPAL_ACCOUNTS } from "../../src/payments/paypal-accounts.js";
import { PAYPAL_WEB_BASE } from "../../src/payments/paypal-config.js";
import { EMAIL_SENDER } from "../../src/notifications/email-sender.js";
import type { EmailMessage, EmailSender } from "../../src/notifications/email-sender.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import { ENGINE_CLIENT } from "../../src/verification/engine-client.js";
import type { EngineClient, RunReport, RunRequest, SuggestCriteriaRequest } from "../../src/verification/engine-client.js";
import { EngineUnavailableError } from "../../src/verification/engine-client.js";
import { VerificationService } from "../../src/verification/verification.service.js";
import { REPOSITORY_RESOLVER } from "../../src/verification/repository-resolver.js";
import type { RepositoryResolver, ResolvedRepository } from "../../src/verification/repository-resolver.js";
import { ProblemException } from "../../src/errors/problem.js";

// GitHub without the network: a repository resolves to the head given here, or is unreadable.
export class FakeRepositories implements RepositoryResolver {
  heads = new Map<string, string>();
  resolve(url: string, commitSha: string | null | undefined): Promise<ResolvedRepository> {
    const canonical = url.replace(/\.git$/, "").replace(/\/tree\/.*$/, "");
    const head = this.heads.get(canonical);
    if (head === undefined) return Promise.reject(new ProblemException("REPOSITORY_UNREADABLE", 422, "The repository cannot be read", "fake", { reason: "fake" }));
    return Promise.resolve({ url: canonical, commitSha: commitSha ?? head });
  }
}

// The Engine as Core sees it through internal-api.yaml: records what was dispatched and answers
// getRun with whatever the test scripts. down=true makes it unreachable.
export class FakeEngine implements EngineClient {
  readonly runs: RunRequest[] = [];
  readonly reports = new Map<string, RunReport>();
  down = false;
  createRun(request: RunRequest): Promise<void> {
    if (this.down) return Promise.reject(new EngineUnavailableError("connect ECONNREFUSED"));
    this.runs.push(request);
    return Promise.resolve();
  }
  getRun(runId: string): Promise<RunReport | null> {
    if (this.down) return Promise.reject(new EngineUnavailableError("connect ECONNREFUSED"));
    return Promise.resolve(this.reports.get(runId) ?? null);
  }
  readonly suggestions: SuggestCriteriaRequest[] = [];
  // What the next suggestion answers instead of the usual one, for an Engine off contract.
  nextSuggestion: unknown = undefined;
  // Set to fail like a call that got through and then ran out of time.
  suggestionTimesOut = false;
  suggestCriteria(request: SuggestCriteriaRequest): Promise<unknown> {
    if (this.down) return Promise.reject(new EngineUnavailableError("connect ECONNREFUSED", true));
    if (this.suggestionTimesOut) return Promise.reject(new EngineUnavailableError("timed out", false));
    this.suggestions.push(request);
    const next = this.nextSuggestion;
    this.nextSuggestion = undefined;
    return Promise.resolve(
      next ?? {
        suggestionId: randomUUID(),
        criteria: [
          { text: "The page answers 200", level: "AUTOMATIC", checkType: "HTTP_PROBE", checkConfig: { url: "https://acme.example", method: "GET", expectStatus: 200 }, required: true, weightBps: 7_000, rationale: "Live" },
          { text: "It reads well", level: "HUMAN", checkType: null, checkConfig: null, required: false, weightBps: 3_000, rationale: "Taste" },
        ],
        ambiguities: [{ term: "nice", excerpt: "a nice page", problem: "Vague", alternatives: ["..."] }],
        notes: "",
      },
    );
  }
}

// The mail server: remembers what it was asked to send, or fails on demand.
export class CapturingEmails implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failNext = false;
  send(message: EmailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("mail server down"));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}

// Service key pairs for the bridge (service-boundaries.md section 3), one set per test run.
const coreKeys = generateKeyPairSync("ed25519");
const engineKeys = generateKeyPairSync("ed25519");

// A clock the tests move by hand: the countdown ends when the test says so, not after a sleep.
export class TestClock implements Clock {
  private at = Date.now();
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

export class CapturingSender implements InvitationSender {
  readonly sent: { email: string; token: string; contractId: string }[] = [];
  send(email: string, token: string, contractId: string): void {
    this.sent.push({ email, token, contractId });
  }
  lastToken(): string {
    const last = this.sent.at(-1);
    if (last === undefined) throw new Error("no invitation sent");
    return last.token;
  }
}

// Scripted PayPal: tests decide what PayPal "says" for each user, and see what was asked.
export class FakePaypalAccounts implements PaypalAccounts {
  readonly sellers = new Map<string, SellerStatus>();
  readonly referrals: { trackingId: string; returnUrl: string; requestId: string }[] = [];
  nextLogin: LinkedPaypalAccount = { payerId: "PAYER-TEST", email: "buyer@paypal.example" };

  createSellerReferral(trackingId: string, returnUrl: string, requestId: string): Promise<string> {
    this.referrals.push({ trackingId, returnUrl, requestId });
    return Promise.resolve(`https://www.sandbox.paypal.com/referral/${trackingId}`);
  }
  findSeller(trackingId: string): Promise<SellerStatus | null> {
    return Promise.resolve(this.sellers.get(trackingId) ?? null);
  }
  loginUrl(state: string, redirectUri: string): string {
    return `https://www.sandbox.paypal.com/signin/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  exchangeLoginCode(): Promise<LinkedPaypalAccount> {
    return Promise.resolve(this.nextLogin);
  }
}

export interface TestContext {
  app: INestApplication<App>;
  db: Db;
  invitations: CapturingSender;
  paypal: FakePaypalAccounts;
  payments: FakePaymentProvider;
  jobs: MemoryJobScheduler;
  clock: TestClock;
  milestones: MilestonesService;
  engine: FakeEngine;
  verification: VerificationService;
  emails: CapturingEmails;
  notifications: NotificationsService;
  // The Engine's private key, to sign calls to /internal/v1/events as the Engine would.
  engineKey: KeyObject;
  repositories: FakeRepositories;
  deliveriesDir: string;
  close(): Promise<void>;
}

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) throw new Error("TEST_DATABASE_URL is not set");
  return url;
}

export const TEST_PAYPAL_WEB_BASE = "https://www.sandbox.paypal.com";

export async function bootTestApp(): Promise<TestContext> {
  const invitations = new CapturingSender();
  const paypal = new FakePaypalAccounts();
  const payments = new FakePaymentProvider();
  const jobs = new MemoryJobScheduler();
  const clock = new TestClock();
  const engine = new FakeEngine();
  const emails = new CapturingEmails();
  const repositories = new FakeRepositories();
  const deliveriesDir = mkdtempSync(join(tmpdir(), "settld-deliveries-"));
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: "test",
        SETTLD_DEV_AUTH: "true",
        CORE_DATABASE_URL: testDatabaseUrl(),
        PLATFORM_FEE_BPS: "0",
        SETTLD_DELIVERIES_DIR: deliveriesDir,
        CORE_SERVICE_PRIVATE_KEY: coreKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
        ENGINE_SERVICE_PUBLIC_KEY: engineKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      }),
    ],
  })
    .overrideProvider(INVITATION_SENDER)
    .useValue(invitations)
    .overrideProvider(PAYPAL_ACCOUNTS)
    .useValue(paypal)
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(payments)
    .overrideProvider(JOB_SCHEDULER)
    .useValue(jobs)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(ENGINE_CLIENT)
    .useValue(engine)
    .overrideProvider(EMAIL_SENDER)
    .useValue(emails)
    .overrideProvider(REPOSITORY_RESOLVER)
    .useValue(repositories)
    // The fake provider stands in for PayPal, but the links it would get are still worth testing.
    .overrideProvider(PAYPAL_WEB_BASE)
    .useValue(TEST_PAYPAL_WEB_BASE)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  configureApp(app);
  await app.init();
  const pool = createPool(testDatabaseUrl());
  return {
    app,
    db: createDb(pool),
    invitations,
    paypal,
    payments,
    jobs,
    clock,
    milestones: app.get(MilestonesService),
    engine,
    verification: app.get(VerificationService),
    emails,
    notifications: app.get(NotificationsService),
    engineKey: engineKeys.privateKey,
    repositories,
    deliveriesDir,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

// Tests isolate by data, not by truncation: every test creates its own users and contracts.
// (audit_log refuses TRUNCATE by design, DM-INV-5.)
export async function createUser(db: Db, roles: ("BUYER" | "SELLER" | "COLLABORATOR" | "ADMIN" | "REVIEWER")[], paypal = true): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@test.settld.app`,
      displayName: roles.join("+"),
      roles,
      paypalMerchantId: paypal ? `SANDBOX-${randomUUID().slice(0, 8)}` : null,
      paypalPaymentsReceivable: paypal,
      // Contract tests start after onboarding (DM-INV-8); onboarding has its own tests.
      onboardingCompletedAt: new Date(),
    })
    .returning({ id: users.id });
  if (u === undefined) throw new Error("insert returned nothing");
  return u.id;
}

// Someone who just signed up: no roles, no profile, no PayPal (DM-INV-8 applies).
export async function createNewUser(db: Db): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${randomUUID()}@test.settld.app`, displayName: "New", roles: [] }).returning({ id: users.id });
  if (u === undefined) throw new Error("insert returned nothing");
  return u.id;
}

// A request as a given user (ADR-0001 dev header).
export function as(ctx: TestContext, userId: string) {
  const server = ctx.app.getHttpServer();
  const withUser = (t: request.Test) => t.set("X-Settld-Dev-User", userId);
  return {
    get: (path: string) => withUser(request(server).get(`/v1${path}`)),
    post: (path: string, body?: object, key: string = randomUUID()) =>
      withUser(request(server).post(`/v1${path}`).set("Idempotency-Key", key)).send(body),
    put: (path: string, body: object, ifMatch: string) => withUser(request(server).put(`/v1${path}`).set("If-Match", ifMatch)).send(body),
  };
}

export function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Checkout redesign",
    currency: "USD",
    terms: { releaseCountdownSeconds: 172_800, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
    milestones: [
      {
        title: "Landing page",
        amount: { amountMinor: 50_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: [{ text: "Staging answers 200", level: "AUTOMATIC", required: true, weightBps: 10_000, checkType: "HTTP_PROBE", checkConfig: { url: "https://example.com" } }],
      },
      {
        title: "Checkout flow",
        amount: { amountMinor: 150_000, currency: "USD" },
        dueDate: "2099-02-28",
        criteria: [{ text: "Tests pass", level: "AUTOMATIC", required: true, weightBps: 10_000, checkType: "TESTS_PASSED", checkConfig: {} }],
      },
    ],
    ...overrides,
  };
}

// A contract through H1 (create, invite, submit, both approve): its milestones are APPROVED,
// ready for H2. Returns the ids the payments tests need.
export async function approvedContract(ctx: TestContext, buyer: string, seller: string, body: object = draftBody()) {
  const created = await as(ctx, buyer).post("/contracts", body).expect(201);
  const contractId = (created.body as { id: string }).id;
  await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email: "seller@example.com" }).expect(202);
  await as(ctx, seller).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
  const submitted = await as(ctx, buyer).post(`/contracts/${contractId}/draft:submit`).expect(200);
  const { version, snapshotHash } = submitted.body as { version: number; snapshotHash: string };
  for (const who of [buyer, seller]) {
    await as(ctx, who).post(`/contracts/${contractId}/versions/${String(version)}:approve`, { snapshotHash, acknowledgeLowVerifiability: true }).expect(200);
  }
  const view = await as(ctx, buyer).get(`/contracts/${contractId}`).expect(200);
  const milestoneIds = (view.body as { milestones: { id: string }[] }).milestones.map((m) => m.id);
  return { contractId, milestoneIds };
}
