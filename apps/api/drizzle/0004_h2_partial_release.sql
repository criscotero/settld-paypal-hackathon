CREATE TABLE "core"."human_criterion_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_decisions_run_criterion_uq" UNIQUE("run_id","criterion_id"),
	CONSTRAINT "human_decisions_decision_ck" CHECK (decision = 'APPROVED')
);
--> statement-breakpoint
CREATE TABLE "core"."objections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"criterion_ids" uuid[] NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"raised_by" uuid NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "objections_status_ck" CHECK (status IN ('OPEN', 'CONTESTED', 'ESCALATED', 'WITHDRAWN', 'SUPERSEDED_BY_RESUBMISSION', 'RULED_RELEASE', 'RULED_VOID')),
	CONSTRAINT "objections_reason_ck" CHECK (char_length(reason) BETWEEN 20 AND 5000)
);
--> statement-breakpoint
CREATE TABLE "core"."payment_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"release_id" uuid,
	"type" text NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"platform_fee_minor" bigint,
	"paypal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_events_type_ck" CHECK (type IN ('ORDER_CREATED', 'AUTHORIZED', 'REAUTHORIZED', 'CAPTURE_REQUESTED', 'CAPTURED', 'CAPTURE_DENIED', 'VOID_REQUESTED', 'VOIDED', 'AUTHORIZATION_EXPIRED', 'REFUNDED', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED')),
	CONSTRAINT "payment_events_source_ck" CHECK (source IN ('API_RESPONSE', 'WEBHOOK', 'RECONCILIATION'))
);
--> statement-breakpoint
CREATE TABLE "core"."releases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"transition_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"platform_fee_minor" bigint NOT NULL,
	"counted_bps" integer NOT NULL,
	"final" boolean NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"capture_id" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_milestone_seq_uq" UNIQUE("milestone_id","seq"),
	CONSTRAINT "releases_status_ck" CHECK (status IN ('PENDING', 'CAPTURED', 'FAILED')),
	CONSTRAINT "releases_amount_ck" CHECK (amount_minor > 0 AND platform_fee_minor >= 0 AND platform_fee_minor <= amount_minor),
	CONSTRAINT "releases_bps_ck" CHECK (counted_bps BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "core"."run_outcomes" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"milestone_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"status" text NOT NULL,
	"results" jsonb NOT NULL,
	"report_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."submissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"evidence_links" jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"submitted_by" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "submissions_milestone_attempt_uq" UNIQUE("milestone_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "core"."milestones" DROP CONSTRAINT "milestones_state_ck";--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "paypal_order_id" text;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "authorization_id" text;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "authorization_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "funded_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "released_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "returned_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "window_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD COLUMN "latest_run_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."human_criterion_decisions" ADD CONSTRAINT "human_criterion_decisions_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."human_criterion_decisions" ADD CONSTRAINT "human_criterion_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."objections" ADD CONSTRAINT "objections_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."objections" ADD CONSTRAINT "objections_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_events" ADD CONSTRAINT "payment_events_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_events" ADD CONSTRAINT "payment_events_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "core"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."releases" ADD CONSTRAINT "releases_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."run_outcomes" ADD CONSTRAINT "run_outcomes_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."run_outcomes" ADD CONSTRAINT "run_outcomes_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "core"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."submissions" ADD CONSTRAINT "submissions_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."submissions" ADD CONSTRAINT "submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "objections_milestone_idx" ON "core"."objections" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "objections_one_open_uq" ON "core"."objections" USING btree ("milestone_id") WHERE status IN ('OPEN', 'CONTESTED', 'ESCALATED');--> statement-breakpoint
CREATE INDEX "payment_events_milestone_idx" ON "core"."payment_events" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_one_capture_uq" ON "core"."payment_events" USING btree ("release_id") WHERE type = 'CAPTURED';--> statement-breakpoint
CREATE UNIQUE INDEX "releases_one_pending_uq" ON "core"."releases" USING btree ("milestone_id") WHERE status = 'PENDING';--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD CONSTRAINT "milestones_hold_ck" CHECK (hold_status IN ('NONE', 'ORDER_CREATED', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED', 'CAPTURE_FAILED', 'VOID_PENDING', 'VOIDED', 'EXPIRED'));--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD CONSTRAINT "milestones_state_hold_ck" CHECK (CASE state
        WHEN 'DRAFT' THEN hold_status = 'NONE'
        WHEN 'APPROVED' THEN hold_status IN ('NONE', 'ORDER_CREATED', 'EXPIRED', 'VOIDED')
        WHEN 'RELEASED' THEN hold_status IN ('CAPTURE_PENDING', 'CAPTURED', 'CAPTURE_FAILED')
        WHEN 'CLOSED' THEN hold_status IN ('VOID_PENDING', 'VOIDED', 'EXPIRED')
        WHEN 'VOIDED' THEN hold_status IN ('NONE', 'VOID_PENDING', 'VOIDED', 'EXPIRED')
        ELSE hold_status IN ('AUTHORIZED', 'EXPIRED')
      END);--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD CONSTRAINT "milestones_conservation_ck" CHECK (funded_minor >= 0 AND released_minor >= 0 AND returned_minor >= 0 AND released_minor + returned_minor <= funded_minor);--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD CONSTRAINT "milestones_terminal_settled_ck" CHECK (state NOT IN ('RELEASED', 'CLOSED', 'VOIDED') OR released_minor + returned_minor = funded_minor);--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD CONSTRAINT "milestones_state_ck" CHECK (state IN ('DRAFT', 'APPROVED', 'FUNDED', 'IN_PROGRESS', 'VERIFYING', 'OBJECTION_WINDOW', 'OBJECTED', 'PARTIALLY_RELEASED', 'RELEASED', 'CLOSED', 'VOIDED'));