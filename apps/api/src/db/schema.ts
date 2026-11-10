// Physical schema for `core` (domain-model.md). Columns are snake_case; the API is camelCase (SB-9).
// Status columns are text + CHECK instead of Postgres enums: adding a value to a CHECK is one
// migration, while ALTER TYPE ... ADD VALUE cannot run inside a transaction.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Actor } from "../audit/actor.js";

export const core = pgSchema("core");

// UUIDv7 (Postgres 18): time-ordered, so new rows land at the end of the index.
const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);
}

export const users = core.table("users", {
  id: id(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  roles: text("roles").array().notNull(),
  locale: text("locale").notNull().default("en"),
  // Clerk's `sub` (ADR-0006). Unique: the just-in-time insert relies on it to stay single
  // under concurrent first requests. Null for seeded dev users.
  clerkUserId: text("clerk_user_id").unique(),
  fullName: text("full_name"),
  country: text("country"),
  accountType: text("account_type").$type<AccountType>(),
  businessName: text("business_name"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  paypalMerchantId: text("paypal_merchant_id"),
  paypalPaymentsReceivable: boolean("paypal_payments_receivable").notNull().default(false),
  paypalPayerId: text("paypal_payer_id"),
  paypalEmail: text("paypal_email"),
  // DM-INV-8. Stored, not derived on every read: contract writes check one column.
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  // Professional profile (ADR-0009). inDirectory is opt-in: nobody is findable by default
  // (constitution XI, decision a).
  headline: text("headline"),
  professions: text("professions").array().notNull().default(sql`'{}'::text[]`),
  skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
  bio: text("bio"),
  link: text("link"),
  inDirectory: boolean("in_directory").notNull().default(false),
  professionalUpdatedAt: timestamp("professional_updated_at", { withTimezone: true }),
  createdAt: createdAt(),
}, () => [
  check("users_account_type_ck", sql`account_type IS NULL OR account_type IN ('INDIVIDUAL', 'BUSINESS')`),
  check("users_country_ck", sql`country IS NULL OR country ~ '^[A-Z]{2}$'`),
  // openapi.yaml: Profession and ProfessionalProfile limits.
  check("users_professions_ck", sql.raw(`professions <@ ARRAY[${PROFESSIONS.map((x) => `'${x}'`).join(", ")}]::text[] AND cardinality(professions) <= 5`)),
  check("users_skills_ck", sql`cardinality(skills) <= 12`),
  check("users_link_ck", sql`link IS NULL OR link ~ '^https://'`),
]);

export const PROFESSIONS = [
  "PRODUCT_DESIGNER",
  "SOFTWARE_DEVELOPER",
  "AI_ENGINEER",
  "DATA_ANALYST",
  "QA_ENGINEER",
  "PRODUCT_MANAGER",
  "COPYWRITER",
  "DEVOPS_ENGINEER",
  "OTHER",
] as const;
export type Profession = (typeof PROFESSIONS)[number];

export type AccountType = "INDIVIDUAL" | "BUSINESS";

export const CONTRACT_STATUSES = ["DRAFT", "PENDING_APPROVAL", "LOCKED", "CANCELLED", "COMPLETED"] as const;

export const contracts = core.table(
  "contracts",
  {
    id: id(),
    buyerId: uuid("buyer_id").notNull().references(() => users.id),
    sellerId: uuid("seller_id").references(() => users.id),
    // Null only inside the transaction that creates the contract and its first version.
    currentVersionId: uuid("current_version_id"),
    lockedVersionId: uuid("locked_version_id"),
    // ADR-0018. Both set while listed as an open project; cleared when the buyer withdraws it.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedUntil: timestamp("published_until", { withTimezone: true }),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contracts_buyer_idx").on(t.buyerId), index("contracts_seller_idx").on(t.sellerId), index("contracts_published_idx").on(t.publishedAt, t.id)],
);

export const VERSION_STATUSES = ["DRAFT", "PENDING_APPROVAL", "LOCKED", "SUPERSEDED"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const contractVersions = core.table(
  "contract_versions",
  {
    id: id(),
    contractId: uuid("contract_id").notNull().references(() => contracts.id),
    version: integer("version").notNull(),
    status: text("status").$type<VersionStatus>().notNull(),
    snapshot: jsonb("snapshot").notNull(),
    // Set on draft:submit. From then on snapshot and hash never change (DM-INV-2, trigger).
    snapshotHash: text("snapshot_hash"),
    parentVersionId: uuid("parent_version_id"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("contract_versions_contract_version_uq").on(t.contractId, t.version),
    check("contract_versions_status_ck", oneOf("status", VERSION_STATUSES)),
    check("contract_versions_hash_ck", sql`(status = 'DRAFT') = (snapshot_hash IS NULL)`),
  ],
);

export const PARTY_ROLES = ["BUYER", "SELLER", "COLLABORATOR"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export const contractApprovals = core.table(
  "contract_approvals",
  {
    id: id(),
    contractVersionId: uuid("contract_version_id").notNull().references(() => contractVersions.id),
    snapshotHash: text("snapshot_hash").notNull(),
    partyRole: text("party_role").$type<PartyRole>().notNull(),
    userId: uuid("user_id").notNull().references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Second line of defense behind the contract row lock (ADR-0004). Per person since
    // ADR-0009: a version can have several collaborator approvals, one each.
    unique("contract_approvals_version_user_uq").on(t.contractVersionId, t.userId),
    check("contract_approvals_role_ck", oneOf("party_role", PARTY_ROLES)),
  ],
);

// Collaborators of a contract (ADR-0009). Buyer and seller stay on `contracts`. Being a party
// lets a collaborator see the contract and approve versions that name them in the team.
export const contractParties = core.table(
  "contract_parties",
  {
    contractId: uuid("contract_id").notNull().references(() => contracts.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    partyRole: text("party_role").$type<"COLLABORATOR">().notNull().default("COLLABORATOR"),
    invitedBy: uuid("invited_by").notNull().references(() => users.id),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.contractId, t.userId] }), index("contract_parties_user_idx").on(t.userId), check("contract_parties_role_ck", sql`party_role = 'COLLABORATOR'`)],
);

export const REVIEWER_APPLICATION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"] as const;
export type ReviewerApplicationStatus = (typeof REVIEWER_APPLICATION_STATUSES)[number];

// ADR-0015. A row grants nothing: the permission is the role in users.roles, written with the
// status in one transaction. Who changed what and why is in the audit log.
export const reviewerApplications = core.table(
  "reviewer_applications",
  {
    id: id(),
    userId: uuid("user_id").notNull().unique().references(() => users.id),
    status: text("status").$type<ReviewerApplicationStatus>().notNull().default("PENDING"),
    motivation: text("motivation"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reviewer_applications_status_idx").on(t.status), check("reviewer_applications_status_ck", oneOf("status", REVIEWER_APPLICATION_STATUSES))],
);

export const invitations = core.table("invitations", {
  id: id(),
  contractId: uuid("contract_id").notNull().references(() => contracts.id),
  email: text("email").notNull(),
  // sha256 of the token; a database leak does not leak usable tokens.
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: uuid("accepted_by").references(() => users.id),
  createdAt: createdAt(),
});

export const MILESTONE_STATES = [
  "DRAFT",
  "APPROVED",
  "FUNDED",
  "IN_PROGRESS",
  "VERIFYING",
  "OBJECTION_WINDOW",
  "OBJECTED",
  "PARTIALLY_RELEASED",
  "RELEASED",
  "CLOSED",
  "VOIDED",
] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

export const HOLD_STATUSES = [
  "NONE",
  "ORDER_CREATED",
  "AUTHORIZED",
  "CAPTURE_PENDING",
  "CAPTURED",
  "CAPTURE_FAILED",
  "VOID_PENDING",
  "VOIDED",
  "EXPIRED",
] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

// Money columns: bigint in Postgres (cents of large contracts overflow int4 at USD 21M),
// read as JS numbers. Safe up to 2^53 cents, the same bound draft-input.ts enforces.
const minor = (name: string) => bigint(name, { mode: "number" });

// Runtime row only (owned by 002). Definition fields live in the version snapshot (ADR-0004).
export const milestones = core.table(
  "milestones",
  {
    // Not generated: the id is assigned in the snapshot, before hashing.
    id: uuid("id").primaryKey(),
    contractId: uuid("contract_id").notNull().references(() => contracts.id),
    state: text("state").$type<MilestoneState>().notNull().default("DRAFT"),
    holdStatus: text("hold_status").$type<HoldStatus>().notNull().default("NONE"),
    lockedVersionId: uuid("locked_version_id").references(() => contractVersions.id),
    stateVersion: integer("state_version").notNull().default(0),
    // 002 runtime (ADR-0007). The PayPal fields mirror facts; the amounts are decisions.
    paypalOrderId: text("paypal_order_id"),
    authorizationId: text("authorization_id"),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
    fundedMinor: minor("funded_minor").notNull().default(0),
    releasedMinor: minor("released_minor").notNull().default(0),
    returnedMinor: minor("returned_minor").notNull().default(0),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }),
    latestRunId: uuid("latest_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("milestones_contract_idx").on(t.contractId),
    check("milestones_state_ck", oneOf("state", MILESTONE_STATES)),
    check("milestones_hold_ck", oneOf("hold_status", HOLD_STATUSES)),
    // DM-INV-3: outside DRAFT, a milestone is bound to a locked version.
    check("milestones_locked_ck", sql`state = 'DRAFT' OR locked_version_id IS NOT NULL`),
    // milestone-state-machine.md, section 1: which holdStatus each state allows.
    check(
      "milestones_state_hold_ck",
      sql`CASE state
        WHEN 'DRAFT' THEN hold_status = 'NONE'
        WHEN 'APPROVED' THEN hold_status IN ('NONE', 'ORDER_CREATED', 'EXPIRED', 'VOIDED')
        WHEN 'RELEASED' THEN hold_status IN ('CAPTURE_PENDING', 'CAPTURED', 'CAPTURE_FAILED')
        WHEN 'CLOSED' THEN hold_status IN ('VOID_PENDING', 'VOIDED', 'EXPIRED')
        WHEN 'VOIDED' THEN hold_status IN ('NONE', 'VOID_PENDING', 'VOIDED', 'EXPIRED')
        ELSE hold_status IN ('AUTHORIZED', 'EXPIRED')
      END`,
    ),
    // SM-INV-9, conservation (constitution V). The code computes amounts so this always
    // holds; the constraint turns a bug that would invent or lose a cent into a rollback.
    check(
      "milestones_conservation_ck",
      sql`funded_minor >= 0 AND released_minor >= 0 AND returned_minor >= 0 AND released_minor + returned_minor <= funded_minor`,
    ),
    check(
      "milestones_terminal_settled_ck",
      sql`state NOT IN ('RELEASED', 'CLOSED', 'VOIDED') OR released_minor + returned_minor = funded_minor`,
    ),
  ],
);

// One team member's money in one milestone: one PayPal order and one authorization, paid to
// that member (ADR-0009). The milestone's money columns are the sums of these (holds.ts, rollup),
// checked at commit by a deferred trigger (migration 0012). Every write to a hold happens while
// holding its milestone's row lock, so holds need no lock of their own.
export const holds = core.table(
  "holds",
  {
    id: id(),
    milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
    payeeUserId: uuid("payee_user_id").notNull().references(() => users.id),
    // Frozen when the hold is created: the money goes where the buyer authorized it, even if
    // the member connects another PayPal account later (ADR-0009, failure modes).
    payeeMerchantId: text("payee_merchant_id").notNull(),
    // The member's place in the locked team: the order the buyer approves the orders in.
    position: integer("position").notNull(),
    shareBps: integer("share_bps").notNull(),
    fundedMinor: minor("funded_minor").notNull().default(0),
    releasedMinor: minor("released_minor").notNull().default(0),
    returnedMinor: minor("returned_minor").notNull().default(0),
    holdStatus: text("hold_status").$type<HoldStatus>().notNull().default("NONE"),
    paypalOrderId: text("paypal_order_id"),
    // Kept so that /fund can list an order already approved without asking PayPal again.
    approveUrl: text("approve_url"),
    authorizationId: text("authorization_id"),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("holds_milestone_payee_uq").on(t.milestoneId, t.payeeUserId),
    unique("holds_milestone_position_uq").on(t.milestoneId, t.position),
    check("holds_status_ck", oneOf("hold_status", HOLD_STATUSES)),
    check("holds_share_ck", sql`share_bps BETWEEN 1 AND 10000`),
    // SM-INV-9 per hold: every authorization is conserved on its own, not only their sum.
    check("holds_conservation_ck", sql`funded_minor >= 0 AND released_minor >= 0 AND returned_minor >= 0 AND released_minor + returned_minor <= funded_minor`),
  ],
);

export const RELEASE_STATUSES = ["PENDING", "CAPTURED", "FAILED"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

// One row per capture decided by a release transition (E-CAPTURE, ADR-0007).
export const releases = core.table(
  "releases",
  {
    id: id(),
    milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
    // Per milestone, from 1. Part of the PayPal-Request-Id, so two partial captures on one
    // authorization never share a key and a retry of one never becomes the other.
    seq: integer("seq").notNull(),
    transitionId: text("transition_id").notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: text("currency").notNull(),
    platformFeeMinor: minor("platform_fee_minor").notNull(),
    countedBps: integer("counted_bps").notNull(),
    // The criteria that counted. Already paid for, so they keep counting in later rounds
    // unless PayPal declines this release (milestone-state-machine.md 1.1.0, E-CAPTURE).
    countedCriterionIds: uuid("counted_criterion_ids").array().notNull().default(sql`'{}'::uuid[]`),
    // The run this release was decided on, recorded in the same insert (ADR-0017). An audit view
    // must not deduce it from timestamps: a wrong guess would show the wrong verdict and look fine.
    // Null only on releases decided before this column existed. No foreign key, like latest_run_id:
    // a run that timed out has no outcome row.
    runId: uuid("run_id"),
    final: boolean("final").notNull(),
    status: text("status").$type<ReleaseStatus>().notNull().default("PENDING"),
    captureId: text("capture_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("releases_milestone_seq_uq").on(t.milestoneId, t.seq),
    // SM-INV-11: one capture in flight per milestone. A second release or a void of the
    // remainder must wait until PayPal answers the first one.
    uniqueIndex("releases_one_pending_uq").on(t.milestoneId).where(sql`status = 'PENDING'`),
    check("releases_status_ck", oneOf("status", RELEASE_STATUSES)),
    check("releases_amount_ck", sql`amount_minor > 0 AND platform_fee_minor >= 0 AND platform_fee_minor <= amount_minor`),
    check("releases_bps_ck", sql`counted_bps BETWEEN 1 AND 10000`),
  ],
);

// One capture per hold per release (ADR-0009). The release is the sum of its parts; its status
// is theirs aggregated (domain-model.md, Release).
export const releaseParts = core.table(
  "release_parts",
  {
    id: id(),
    releaseId: uuid("release_id").notNull().references(() => releases.id),
    holdId: uuid("hold_id").notNull().references(() => holds.id),
    amountMinor: minor("amount_minor").notNull(),
    platformFeeMinor: minor("platform_fee_minor").notNull(),
    status: text("status").$type<ReleaseStatus>().notNull().default("PENDING"),
    captureId: text("capture_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("release_parts_release_hold_uq").on(t.releaseId, t.holdId),
    check("release_parts_status_ck", oneOf("status", RELEASE_STATUSES)),
    // A part of 0 is not stored (domain-model.md, ReleasePart): PayPal refuses a 0 capture.
    check("release_parts_amount_ck", sql`amount_minor > 0 AND platform_fee_minor >= 0 AND platform_fee_minor <= amount_minor`),
  ],
);

export const PAYMENT_EVENT_TYPES = [
  "ORDER_CREATED",
  "AUTHORIZED",
  "REAUTHORIZED",
  "CAPTURE_REQUESTED",
  "CAPTURED",
  "CAPTURE_DENIED",
  "VOID_REQUESTED",
  "VOIDED",
  "AUTHORIZATION_EXPIRED",
  "REFUNDED",
  "DISPUTE_OPENED",
  "DISPUTE_RESOLVED",
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

// Append-only ledger mirroring PayPal (constitution V; DM-INV-5, trigger in 0005).
export const paymentEvents = core.table(
  "payment_events",
  {
    id: id(),
    milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
    releaseId: uuid("release_id").references(() => releases.id),
    // Which payee's authorization the fact is about, and which part of a release (ADR-0009).
    holdId: uuid("hold_id").references(() => holds.id),
    releasePartId: uuid("release_part_id").references(() => releaseParts.id),
    type: text("type").$type<PaymentEventType>().notNull(),
    amountMinor: minor("amount_minor"),
    currency: text("currency"),
    platformFeeMinor: minor("platform_fee_minor"),
    paypal: jsonb("paypal").$type<Record<string, string>>().notNull().default({}),
    // The PayPal-Request-Id or webhook event id: the same fact recorded twice is refused.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    source: text("source").$type<"API_RESPONSE" | "WEBHOOK" | "RECONCILIATION">().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payment_events_milestone_idx").on(t.milestoneId),
    // SM-INV-1, per part since ADR-0009: a release has one CAPTURED fact per hold it pays.
    uniqueIndex("payment_events_one_capture_uq").on(t.releasePartId).where(sql`type = 'CAPTURED'`),
    check("payment_events_type_ck", oneOf("type", PAYMENT_EVENT_TYPES)),
    check("payment_events_source_ck", sql`source IN ('API_RESPONSE', 'WEBHOOK', 'RECONCILIATION')`),
  ],
);

export interface EvidenceLink {
  // REPOSITORY and FILE: ADR-0019 and ADR-0020. Core sets commitSha and fileHash on delivery.
  readonly kind: "PULL_REQUEST" | "COMMIT" | "CI_RUN" | "URL" | "OTHER" | "REPOSITORY" | "FILE";
  readonly url: string;
  readonly label?: string;
  readonly commitSha?: string;
  readonly fileHash?: string;
}

export const submissions = core.table(
  "submissions",
  {
    id: id(),
    milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
    attempt: integer("attempt").notNull(),
    evidenceLinks: jsonb("evidence_links").$type<EvidenceLink[]>().notNull(),
    notes: text("notes").notNull().default(""),
    submittedBy: uuid("submitted_by").notNull().references(() => users.id),
    // Generated by Core API before dispatch, so the Engine's result can be matched to it.
    runId: uuid("run_id").notNull().unique(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("submissions_milestone_attempt_uq").on(t.milestoneId, t.attempt)],
);

// ADR-0020, hackathon version: a .zip uploaded for a milestone. The bytes live on the server's
// disk under their SHA-256 (SETTLD_DELIVERIES_DIR); this row says who uploaded it for which
// milestone. Insert only: a file is never replaced, a new upload is a new hash.
export const deliveryFiles = core.table(
  "delivery_files",
  {
    id: id(),
    milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
    fileHash: text("file_hash").notNull(),
    name: text("name").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    entryCount: integer("entry_count").notNull(),
    uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("delivery_files_milestone_hash_uq").on(t.milestoneId, t.fileHash),
    check("delivery_files_hash_ck", sql`file_hash ~ '^sha256:[0-9a-f]{64}$'`),
    check("delivery_files_size_ck", sql`size_bytes BETWEEN 1 AND 26214400`),
  ],
);

export type Verdict = "PASS" | "FAIL" | "UNCERTAIN" | "NEEDS_HUMAN";

export interface CriterionVerdict {
  readonly criterionId: string;
  readonly verdict: Verdict;
  readonly evidenceRefCount: number;
}

// RunOutcome (Core API copy of the Engine's result). In H2 the tests write it through
// MilestonesService.applyRunCompleted; in H4 the inbox will.
export const runOutcomes = core.table("run_outcomes", {
  runId: uuid("run_id").primaryKey(),
  milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id),
  status: text("status").$type<"COMPLETED" | "TIMED_OUT">().notNull(),
  results: jsonb("results").$type<CriterionVerdict[]>().notNull(),
  reportHash: text("report_hash"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// Constitution VI and D7: a person approves what a check cannot prove. Keyed by run: each
// round of verification is judged on its own evidence.
export const humanCriterionDecisions = core.table(
  "human_criterion_decisions",
  {
    id: id(),
    milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
    runId: uuid("run_id").notNull(),
    criterionId: uuid("criterion_id").notNull(),
    decision: text("decision").$type<"APPROVED">().notNull(),
    decidedBy: uuid("decided_by").notNull().references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("human_decisions_run_criterion_uq").on(t.runId, t.criterionId), check("human_decisions_decision_ck", sql`decision = 'APPROVED'`)],
);

export const OBJECTION_STATUSES = ["OPEN", "CONTESTED", "ESCALATED", "WITHDRAWN", "SUPERSEDED_BY_RESUBMISSION", "RULED_RELEASE", "RULED_VOID", "SURRENDERED"] as const;
export type ObjectionStatus = (typeof OBJECTION_STATUSES)[number];

export const objections = core.table(
  "objections",
  {
    id: id(),
    milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
    runId: uuid("run_id").notNull(),
    criterionIds: uuid("criterion_ids").array().notNull(),
    reason: text("reason").notNull(),
    status: text("status").$type<ObjectionStatus>().notNull().default("OPEN"),
    raisedBy: uuid("raised_by").notNull().references(() => users.id),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    // Stored, not computed: the third objection of a milestone escalates at once (ADR-0014).
    escalateAt: timestamp("escalate_at", { withTimezone: true }).notNull(),
    contestedAt: timestamp("contested_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolutionReason: text("resolution_reason"),
  },
  (t) => [
    index("objections_milestone_idx").on(t.milestoneId),
    // G-NO-OPEN-OBJECTION relies on there being at most one live objection.
    uniqueIndex("objections_one_open_uq").on(t.milestoneId).where(sql`status IN ('OPEN', 'CONTESTED', 'ESCALATED')`),
    check("objections_status_ck", oneOf("status", OBJECTION_STATUSES)),
    check("objections_reason_ck", sql`char_length(reason) BETWEEN 20 AND 5000`),
  ],
);

// The resolution thread (domain-model.md, ObjectionMessage). For now only the seller's contest
// writes here, so the Reviewer hears both sides (ADR-0014).
export const objectionMessages = core.table(
  "objection_messages",
  {
    id: id(),
    objectionId: uuid("objection_id").notNull().references(() => objections.id),
    authorId: uuid("author_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("objection_messages_objection_idx").on(t.objectionId), check("objection_messages_body_ck", sql`char_length(body) BETWEEN 1 AND 5000`)],
);

// Append-only (DM-INV-5, trigger). Written in the same transaction as the change it records.
export const auditLog = core.table(
  "audit_log",
  {
    id: id(),
    actor: jsonb("actor").$type<Actor>().notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    contractId: uuid("contract_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    requestId: text("request_id").notNull(),
    traceId: text("trace_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  // entity: Milestone.returnReason reads each milestone's last transition on every contract view.
  (t) => [index("audit_log_contract_idx").on(t.contractId), index("audit_log_entity_idx").on(t.entityId, t.at)],
);

// What was sent to whom (ADR-0011). Ids only in the payload: the text of a mail can quote what a
// model read in the seller's page, and that does not need a second copy here.
export const notifications = core.table(
  "notifications",
  {
    id: id(),
    // A repeated job finds the row and does not send again.
    dedupeKey: text("dedupe_key").notNull().unique(),
    // Null for an invitation to someone with no account yet (ADR-0013).
    userId: uuid("user_id").references(() => users.id),
    template: text("template").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").$type<"PENDING" | "SENT" | "SUPPRESSED">().notNull().default("PENDING"),
    reason: text("reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("notifications_status_ck", sql`${t.status} IN ('PENDING', 'SENT', 'SUPPRESSED')`)],
);

// Transactional outbox (constitution IV). H1 writes; H4 adds the dispatcher.
export const outbox = core.table(
  "outbox",
  {
    id: id(), // event id, UUIDv7 as events.md requires
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actor: jsonb("actor").$type<Actor>().notNull(),
    contractId: uuid("contract_id"),
    milestoneId: uuid("milestone_id"),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    payload: jsonb("payload").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index("outbox_unpublished_idx").on(t.occurredAt).where(sql`published_at IS NULL`)],
);

// errors.md: Idempotency-Key, stored 24 hours with the response.
export const idempotencyKeys = core.table(
  "idempotency_keys",
  {
    userId: uuid("user_id").notNull(),
    key: uuid("key").notNull(),
    // sha256 of method + path + body: the same key with a different request is IDEMPOTENCY_KEY_REUSED.
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// How many AI suggestions were asked for per day (ADR-0016, decision 4). `scope` is a user id, or
// "global" for everyone: a cap that only counted per user would not survive a pile of new accounts.
export const aiSuggestionUsage = core.table(
  "ai_suggestion_usage",
  {
    day: date("day").notNull(),
    scope: text("scope").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.scope] })],
);

// Service tokens Core API accepted (service-boundaries.md section 3). The primary key is the
// replay check; rows only matter until the token expires and are deleted as new ones arrive.
export const serviceTokenJti = core.table(
  "service_token_jti",
  {
    jti: text("jti").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("service_token_jti_expires_idx").on(t.expiresAt)],
);

// Inbound messages: Engine events now, PayPal and GitHub webhooks later (events.md section 5).
// Stored first and processed by a job, in the same transaction as the job row: the sender gets
// its 200 as soon as the fact is durable, and a crash before processing loses nothing.
// Unique on (provider, external_event_id): a redelivery is a no-op (constitution III).
export const inbox = core.table(
  "inbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    provider: text("provider").$type<"PAYPAL" | "GITHUB" | "ENGINE">().notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    unique("inbox_provider_event_uq").on(t.provider, t.externalEventId),
    check("inbox_provider_ck", sql`provider IN ('PAYPAL', 'GITHUB', 'ENGINE')`),
    // events.md: signatureVerified must be true to process. Nothing unverified is even stored.
    check("inbox_verified_ck", sql`signature_verified`),
  ],
);
