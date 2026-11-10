// Demo database (settld_demo only): 10 realistic contracts covering every milestone state, so
// the dashboards and the tracking page have something to show. Run through scripts/demo_db.sh,
// which drops and recreates the database first.
//
// Rows are written directly, not through the use cases: states after APPROVED (FUNDED,
// RELEASED, ...) need H2 to H5, which do not exist yet. Consequences, on purpose:
// - Snapshots and hashes are real (buildSnapshot + hashSnapshot), so DM-INV-2 holds and the
//   approvals match their version exactly as approveVersion would record them.
// - Money states are fabricated: there are no PayPal orders, authorizations or ledger rows
//   (payment_events does not exist yet). holdStatus is set to what each state implies.
// - No audit_log or outbox rows: this is fixture data, not history.
// Never point this at `settld` or `settld_test`: the guard below refuses.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DraftInput } from "../contracts/draft-input.js";
import { buildSnapshot, hashSnapshot } from "../contracts/snapshot.js";
import { createDb, createPool } from "./database.js";
import type { Db } from "./database.js";
import { asOnboarded, DEV_USERS } from "./dev-users.js";
import { contractApprovals, contracts, contractVersions, milestones, users } from "./schema.js";
import type { HoldStatus, MilestoneState } from "./schema.js";

const url = process.env.CORE_DATABASE_URL;
if (url === undefined) throw new Error("CORE_DATABASE_URL is not set (see .env.example)");
if (new URL(url).pathname !== "/settld_demo") {
  throw new Error(`seed-demo only writes to the settld_demo database, got ${new URL(url).pathname}. Use scripts/demo_db.sh.`);
}

// Ada (admin) is seeded too but is a party to nothing (G-ACTOR-NEUTRAL).
const [CARLA, FEDE] = DEV_USERS.map((u) => u.id) as [string, string, string];
const LUCIA = "00000000-0000-7000-8000-00000001c1a0";
const KENJI = "00000000-0000-7000-8000-00000000ce71";
const MAYA = "00000000-0000-7000-8000-000000004a7a";
const OMAR = "00000000-0000-7000-8000-0000000003a2";

const DEMO_USERS = [
  ...DEV_USERS,
  { id: LUCIA, email: "lucia.romero@demo.settld.app", displayName: "Lucía Romero", roles: ["SELLER"], paypalMerchantId: "SANDBOX-LUCIA" },
  { id: KENJI, email: "kenji.watanabe@demo.settld.app", displayName: "Kenji Watanabe", roles: ["SELLER"], paypalMerchantId: "SANDBOX-KENJI" },
  { id: MAYA, email: "maya@northwindlabs.demo.settld.app", displayName: "Maya Patel (Northwind Labs)", roles: ["BUYER"], paypalMerchantId: null },
  { id: OMAR, email: "omar@bluefinhealth.demo.settld.app", displayName: "Omar Haddad (Bluefin Health)", roles: ["BUYER"], paypalMerchantId: null },
];

// ---------------------------------------------------------------- dates

const TODAY = new Date();
const day = (offset: number) => new Date(TODAY.getTime() + offset * 86_400_000);
const isoDate = (offset: number) => day(offset).toISOString().slice(0, 10);

// ---------------------------------------------------------------- criteria

// Weights are assigned in toDraft, so the helpers below build everything else.
type Criterion = Omit<DraftInput["milestones"][number]["criteria"][number], "weightBps">;

// Equal shares that add up to exactly 10 000 bp: the remainder goes to the first criteria,
// one basis point each. Written into the snapshot, so the split is explicit and hashed.
function equalWeights(n: number): number[] {
  const base = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10_000 - base * n ? 1 : 0));
}

const http = (text: string, url: string): Criterion => ({
  text,
  level: "AUTOMATIC",
  checkType: "HTTP_PROBE",
  checkConfig: { url, method: "GET", expectStatus: 200, maxResponseMs: 2000 },
});
const prMerged = (text: string, repository: string): Criterion => ({
  text,
  level: "AUTOMATIC",
  checkType: "GITHUB_PR_MERGED",
  checkConfig: { repository, baseBranch: "main" },
});
const ciGreen = (text: string, repository: string, workflow = "ci.yml"): Criterion => ({
  text,
  level: "AUTOMATIC",
  checkType: "CI_STATUS_GREEN",
  checkConfig: { repository, workflow, ref: "main" },
});
const ai = (text: string, guidance: string, url?: string): Criterion => ({
  text,
  level: "AI_EVALUATED",
  checkType: "AI_REQUIREMENT_MET",
  checkConfig: { sources: url ? ["SCREENSHOT", "HTTP_RESPONSE"] : ["DIFF", "NOTES"], guidance, ...(url ? { url } : {}) },
});
const human = (text: string, required = true): Criterion => ({ text, level: "HUMAN", required });

// ---------------------------------------------------------------- contracts

interface MilestoneSpec {
  title: string;
  description: string;
  amount: number; // major units
  due: number; // days from today
  state: MilestoneState;
  criteria: Criterion[];
}

interface ContractSpec {
  title: string;
  description: string;
  currency: "USD" | "EUR";
  buyer: string;
  seller: string | null;
  createdDaysAgo: number;
  windowHours?: number;
  // DRAFT: never submitted. PENDING: submitted, `approvedBy` so far. LOCKED: both approved.
  agreement: { status: "DRAFT" } | { status: "PENDING"; approvedBy: ("BUYER" | "SELLER")[] } | { status: "LOCKED"; amendedOnce?: boolean };
  milestones: MilestoneSpec[];
}

const CONTRACTS: ContractSpec[] = [
  {
    title: "Acme storefront redesign",
    description: "Redesign of the Acme online store: new design system, product pages and a faster checkout. Figma file shared in the kickoff email.",
    currency: "USD",
    buyer: CARLA,
    seller: FEDE,
    createdDaysAgo: 41,
    agreement: { status: "LOCKED", amendedOnce: true },
    milestones: [
      {
        title: "Design system and component library",
        description: "Tokens, typography and 24 core components in Storybook.",
        amount: 2400,
        due: -18,
        state: "RELEASED",
        criteria: [http("Storybook is published", "https://storybook.acme-demo.dev"), prMerged("Component library merged to main", "acme/storefront"), human("Buyer signs off on the visual style")],
      },
      {
        title: "Product listing and detail pages",
        description: "Responsive listing with filters, and the product detail page with gallery and reviews.",
        amount: 3200,
        due: -2,
        state: "OBJECTION_WINDOW",
        criteria: [
          http("Staging listing page answers", "https://staging.acme-demo.dev/products"),
          ciGreen("CI is green on main", "acme/storefront"),
          ai("Filters work on mobile", "Check that category and price filters are usable at 375px wide.", "https://staging.acme-demo.dev/products"),
        ],
      },
      {
        title: "One-page checkout",
        description: "Single-page checkout with address autocomplete and PayPal button.",
        amount: 2800,
        due: 16,
        state: "IN_PROGRESS",
        criteria: [http("Checkout page answers on staging", "https://staging.acme-demo.dev/checkout"), ciGreen("End-to-end checkout tests pass", "acme/storefront", "e2e.yml"), human("Buyer completes a test purchase")],
      },
    ],
  },
  {
    title: "Mobile banking app: onboarding flow",
    description: "React Native onboarding for the Pocket Bank app: sign-up, KYC capture, and first deposit.",
    currency: "USD",
    buyer: CARLA,
    seller: FEDE,
    createdDaysAgo: 60,
    windowHours: 72,
    agreement: { status: "LOCKED" },
    milestones: [
      { title: "Sign-up and email verification", description: "", amount: 1800, due: -35, state: "RELEASED", criteria: [prMerged("Sign-up flow merged", "pocketbank/app"), ciGreen("Unit tests green", "pocketbank/app")] },
      { title: "KYC document capture", description: "Camera capture, edge detection and upload to the KYC vendor sandbox.", amount: 2600, due: -12, state: "RELEASED", criteria: [prMerged("KYC module merged", "pocketbank/app"), human("Compliance team approves the capture UX")] },
      { title: "First deposit screen", description: "", amount: 1500, due: -1, state: "VERIFYING", criteria: [prMerged("Deposit screen merged", "pocketbank/app"), ai("Copy matches the approved legal text", "Compare the screen copy with docs/legal/deposit.md.")] },
      { title: "Accessibility pass", description: "Screen reader labels and dynamic type across onboarding.", amount: 900, due: 21, state: "FUNDED", criteria: [ai("Every input has an accessible label", "Inspect the onboarding screens for missing accessibilityLabel."), human("Buyer tests with VoiceOver")] },
    ],
  },
  {
    title: "Data pipeline migration to dbt",
    description: "Move the nightly SQL scripts to dbt models with tests and documentation.",
    currency: "USD",
    buyer: CARLA,
    seller: LUCIA,
    createdDaysAgo: 25,
    agreement: { status: "LOCKED" },
    milestones: [
      { title: "Staging models for orders and customers", description: "", amount: 2000, due: -4, state: "OBJECTED", criteria: [prMerged("Models merged", "carla-co/analytics"), ciGreen("dbt test passes", "carla-co/analytics", "dbt.yml"), human("Row counts match the legacy tables")] },
      { title: "Marts and incremental loads", description: "", amount: 2500, due: 18, state: "APPROVED", criteria: [ciGreen("dbt build is green", "carla-co/analytics", "dbt.yml"), human("Finance validates the revenue mart")] },
      { title: "Docs site and handover", description: "", amount: 800, due: 30, state: "APPROVED", criteria: [http("dbt docs site is published", "https://analytics-docs.carla-demo.dev"), human("Handover call held", false)] },
    ],
  },
  {
    title: "Brand identity refresh",
    description: "New logo, palette and brand guidelines for the 2027 relaunch.",
    currency: "USD",
    buyer: CARLA,
    seller: KENJI,
    createdDaysAgo: 90,
    agreement: { status: "LOCKED" },
    milestones: [
      { title: "Logo concepts", description: "Three directions, one refined.", amount: 1200, due: -70, state: "RELEASED", criteria: [human("Buyer picks a direction")] },
      { title: "Brand guidelines PDF", description: "", amount: 1600, due: -45, state: "RELEASED", criteria: [ai("Guidelines cover logo, color, type and voice", "Check the PDF has the four sections with examples."), human("Buyer approves the final PDF")] },
    ],
  },
  {
    title: "Customer support chatbot",
    description: "A support bot trained on the help center, with handoff to a human agent.",
    currency: "USD",
    buyer: CARLA,
    seller: null,
    createdDaysAgo: 2,
    agreement: { status: "DRAFT" },
    milestones: [
      { title: "Help center ingestion", description: "", amount: 1500, due: 20, state: "DRAFT", criteria: [ciGreen("Ingestion job passes", "carla-co/support-bot")] },
      { title: "Chat widget on the website", description: "", amount: 2000, due: 35, state: "DRAFT", criteria: [http("Widget script is served", "https://cdn.carla-demo.dev/widget.js"), human("Buyer tries ten real questions")] },
      { title: "Human handoff", description: "", amount: 1200, due: 45, state: "DRAFT", criteria: [human("A conversation reaches the Zendesk queue")] },
    ],
  },
  {
    title: "Marketing site i18n (ES and PT)",
    description: "Translate and localize the marketing site into Spanish and Portuguese.",
    currency: "USD",
    buyer: CARLA,
    seller: FEDE,
    createdDaysAgo: 4,
    agreement: { status: "PENDING", approvedBy: ["BUYER"] },
    milestones: [
      { title: "i18n framework and Spanish", description: "", amount: 1400, due: 14, state: "DRAFT", criteria: [http("Spanish home page answers", "https://www.carla-demo.dev/es"), ai("No untranslated strings on key pages", "Scan /es for English strings.", "https://www.carla-demo.dev/es")] },
      { title: "Portuguese", description: "", amount: 1100, due: 28, state: "DRAFT", criteria: [http("Portuguese home page answers", "https://www.carla-demo.dev/pt")] },
    ],
  },
  {
    title: "Inventory API v2",
    description: "Rewrite of the inventory service API with stock reservations and webhooks.",
    currency: "EUR",
    buyer: MAYA,
    seller: FEDE,
    createdDaysAgo: 33,
    agreement: { status: "LOCKED" },
    milestones: [
      { title: "Reservations endpoint", description: "", amount: 3000, due: -10, state: "RELEASED", criteria: [prMerged("Endpoint merged", "northwind/inventory"), ciGreen("Contract tests pass", "northwind/inventory")] },
      { title: "Webhooks with retries", description: "", amount: 2500, due: 9, state: "IN_PROGRESS", criteria: [prMerged("Webhooks merged", "northwind/inventory"), ai("Retries use exponential backoff", "Read the delivery worker and confirm backoff with jitter.")] },
      { title: "Load test report", description: "", amount: 1200, due: 24, state: "APPROVED", criteria: [human("p95 latency under 200 ms at 500 rps")] },
    ],
  },
  {
    title: "Patient portal accessibility audit",
    description: "WCAG 2.2 AA audit of the patient portal and fixes for critical issues.",
    currency: "USD",
    buyer: OMAR,
    seller: FEDE,
    createdDaysAgo: 19,
    windowHours: 48,
    agreement: { status: "LOCKED" },
    milestones: [
      { title: "Audit report", description: "", amount: 1800, due: -3, state: "OBJECTION_WINDOW", criteria: [ai("Report covers every WCAG 2.2 AA criterion", "Check the report lists all success criteria with pass or fail."), human("Buyer reviews the findings")] },
      { title: "Fix critical issues", description: "", amount: 2200, due: 20, state: "FUNDED", criteria: [ciGreen("axe checks pass in CI", "bluefin/portal", "a11y.yml"), human("Screen reader walkthrough")] },
    ],
  },
  {
    title: "Analytics dashboard for sales",
    description: "Internal dashboard with pipeline, win rate and forecast.",
    currency: "USD",
    buyer: MAYA,
    seller: FEDE,
    createdDaysAgo: 3,
    agreement: { status: "PENDING", approvedBy: ["SELLER"] },
    milestones: [
      { title: "Pipeline and win-rate views", description: "", amount: 2100, due: 17, state: "DRAFT", criteria: [http("Dashboard answers", "https://bi.northwind-demo.dev/sales"), human("Sales lead validates the numbers")] },
      { title: "Forecast model", description: "", amount: 1900, due: 32, state: "DRAFT", criteria: [ai("Forecast explains its assumptions", "Check the forecast page states inputs and method."), human("Sales lead approves")] },
    ],
  },
  {
    title: "Product launch video",
    description: "60-second launch video with motion graphics.",
    currency: "USD",
    buyer: CARLA,
    seller: KENJI,
    createdDaysAgo: 50,
    agreement: { status: "LOCKED" },
    milestones: [
      { title: "Storyboard", description: "", amount: 700, due: -30, state: "RELEASED", criteria: [human("Buyer approves the storyboard")] },
      { title: "Final cut", description: "Cancelled before delivery: the launch moved to 2027.", amount: 2300, due: -5, state: "VOIDED", criteria: [human("Buyer approves the final cut")] },
    ],
  },
];

// ---------------------------------------------------------------- what each state implies

// Order of the happy path, used for stateVersion (one increment per transition).
const STEPS: Record<MilestoneState, number> = {
  DRAFT: 0,
  APPROVED: 1,
  FUNDED: 2,
  IN_PROGRESS: 3,
  VERIFYING: 4,
  OBJECTION_WINDOW: 5,
  OBJECTED: 6,
  PARTIALLY_RELEASED: 6,
  RELEASED: 6,
  CLOSED: 7,
  VOIDED: 4,
};

function holdFor(state: MilestoneState): HoldStatus {
  if (state === "DRAFT" || state === "APPROVED") return "NONE";
  if (state === "RELEASED") return "CAPTURED";
  if (state === "VOIDED" || state === "CLOSED") return "VOIDED";
  return "AUTHORIZED"; // FUNDED .. OBJECTED: money reserved in the buyer's PayPal
}

function toDraft(spec: ContractSpec): DraftInput {
  return {
    title: spec.title,
    description: spec.description,
    currency: spec.currency,
    terms: { releaseCountdownSeconds: (spec.windowHours ?? 48) * 3600, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
    milestones: spec.milestones.map((m) => ({
      title: m.title,
      description: m.description,
      // Integer arithmetic: whole major units only in this fixture.
      amount: { amountMinor: m.amount * 100, currency: spec.currency },
      dueDate: isoDate(m.due),
      criteria: m.criteria.map((c, i, all) => ({ ...c, weightBps: equalWeights(all.length)[i] ?? 0 })),
    })),
  };
}

const userActor = (id: string) => ({ type: "USER" as const, id });

async function seedContract(db: Db, spec: ContractSpec): Promise<void> {
  const created = day(-spec.createdDaysAgo);
  const snapshot = buildSnapshot(toDraft(spec), { platformFeeBps: 0, newId: randomUUID, knownMilestoneIds: new Set(), knownCriterionIds: new Set() });

  await db.transaction(async (tx) => {
    const [contract] = await tx
      .insert(contracts)
      .values({ buyerId: spec.buyer, sellerId: spec.seller, createdAt: created, updatedAt: created })
      .returning();
    if (contract === undefined) throw new Error("insert returned nothing");

    let parentVersionId: string | null = null;
    let number = 1;
    if (spec.agreement.status === "LOCKED" && spec.agreement.amendedOnce === true) {
      // A realistic history: version 1 was submitted, then edited before anyone approved.
      const v1Snapshot = { ...snapshot, description: `${snapshot.description} (first draft)` };
      const [v1] = await tx
        .insert(contractVersions)
        .values({ contractId: contract.id, version: 1, status: "SUPERSEDED", snapshot: v1Snapshot, snapshotHash: hashSnapshot(v1Snapshot), createdBy: userActor(spec.buyer), createdAt: created })
        .returning();
      parentVersionId = v1?.id ?? null;
      number = 2;
    }

    const status = spec.agreement.status === "DRAFT" ? "DRAFT" : spec.agreement.status === "PENDING" ? "PENDING_APPROVAL" : "LOCKED";
    const hash = status === "DRAFT" ? null : hashSnapshot(snapshot);
    const [version] = await tx
      .insert(contractVersions)
      .values({ contractId: contract.id, version: number, status, snapshot, snapshotHash: hash, parentVersionId, createdBy: userActor(spec.buyer), createdAt: created })
      .returning();
    if (version === undefined) throw new Error("insert returned nothing");

    const approvers: ("BUYER" | "SELLER")[] = spec.agreement.status === "LOCKED" ? ["BUYER", "SELLER"] : spec.agreement.status === "PENDING" ? spec.agreement.approvedBy : [];
    for (const [i, role] of approvers.entries()) {
      const userId = role === "BUYER" ? spec.buyer : spec.seller;
      if (userId === null || hash === null) throw new Error(`${spec.title}: ${role} cannot approve`);
      await tx.insert(contractApprovals).values({ contractVersionId: version.id, snapshotHash: hash, partyRole: role, userId, approvedAt: day(-spec.createdDaysAgo + 1 + i) });
    }

    await tx
      .update(contracts)
      .set({ currentVersionId: version.id, lockedVersionId: status === "LOCKED" ? version.id : null })
      .where(eq(contracts.id, contract.id));

    for (const [i, m] of spec.milestones.entries()) {
      const def = snapshot.milestones[i];
      if (def === undefined) throw new Error("snapshot lost a milestone");
      await tx.insert(milestones).values({
        id: def.id,
        contractId: contract.id,
        state: m.state,
        holdStatus: holdFor(m.state),
        // Conservation (SM-INV-9): what each state implies, with the whole amount. The demo
        // has no partial releases, so a released milestone released all of it.
        fundedMinor: m.state === "DRAFT" || m.state === "APPROVED" ? 0 : def.amount.amountMinor,
        releasedMinor: m.state === "RELEASED" ? def.amount.amountMinor : 0,
        returnedMinor: m.state === "VOIDED" ? def.amount.amountMinor : 0,
        lockedVersionId: m.state === "DRAFT" ? null : version.id,
        stateVersion: STEPS[m.state],
        createdAt: created,
      });
    }
  });
}

// ---------------------------------------------------------------- run

const pool = createPool(url);
try {
  const db = createDb(pool);
  const existing = await db.select({ id: contracts.id }).from(contracts).limit(1);
  if (existing.length > 0) throw new Error("settld_demo already has contracts. Reset it with scripts/demo_db.sh.");

  await db.insert(users).values(DEMO_USERS.map(asOnboarded)).onConflictDoNothing();
  for (const spec of CONTRACTS) await seedContract(db, spec);

  const states = CONTRACTS.flatMap((c) => c.milestones.map((m) => m.state));
  console.log(`Seeded settld_demo: ${String(DEMO_USERS.length)} users, ${String(CONTRACTS.length)} contracts, ${String(states.length)} milestones`);
  console.log(`  states: ${[...new Set(states)].join(", ")}`);
  for (const u of DEV_USERS) console.log(`  ${u.roles.join(",").padEnd(10)} ${u.displayName.padEnd(16)} X-Settld-Dev-User: ${u.id}`);
} finally {
  await pool.end();
}
