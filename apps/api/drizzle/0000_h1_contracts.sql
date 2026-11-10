-- `core` already exists: the init script creates it owned by core_app (SB-3).
--> statement-breakpoint
CREATE TABLE "core"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"contract_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"request_id" text NOT NULL,
	"trace_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."contract_approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"contract_version_id" uuid NOT NULL,
	"snapshot_hash" text NOT NULL,
	"party_role" text NOT NULL,
	"user_id" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_approvals_version_role_uq" UNIQUE("contract_version_id","party_role"),
	CONSTRAINT "contract_approvals_role_ck" CHECK (party_role IN ('CLIENT', 'FREELANCER'))
);
--> statement-breakpoint
CREATE TABLE "core"."contract_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"contract_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text,
	"parent_version_id" uuid,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_versions_contract_version_uq" UNIQUE("contract_id","version"),
	CONSTRAINT "contract_versions_status_ck" CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'LOCKED', 'SUPERSEDED')),
	CONSTRAINT "contract_versions_hash_ck" CHECK ((status = 'DRAFT') = (snapshot_hash IS NULL))
);
--> statement-breakpoint
CREATE TABLE "core"."contracts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"freelancer_id" uuid,
	"current_version_id" uuid,
	"locked_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "core"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"contract_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "core"."milestones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contract_id" uuid NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"hold_status" text DEFAULT 'NONE' NOT NULL,
	"locked_version_id" uuid,
	"state_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_state_ck" CHECK (state IN ('DRAFT', 'APPROVED', 'FUNDED', 'IN_PROGRESS', 'VERIFYING', 'OBJECTION_WINDOW', 'OBJECTED', 'RELEASED', 'VOIDED')),
	CONSTRAINT "milestones_locked_ck" CHECK (state = 'DRAFT' OR locked_version_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "core"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" jsonb NOT NULL,
	"contract_id" uuid,
	"milestone_id" uuid,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"roles" text[] NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"paypal_merchant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "core"."contract_approvals" ADD CONSTRAINT "contract_approvals_contract_version_id_contract_versions_id_fk" FOREIGN KEY ("contract_version_id") REFERENCES "core"."contract_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_approvals" ADD CONSTRAINT "contract_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_versions" ADD CONSTRAINT "contract_versions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "core"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contracts" ADD CONSTRAINT "contracts_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contracts" ADD CONSTRAINT "contracts_freelancer_id_users_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "core"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD CONSTRAINT "milestones_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "core"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."milestones" ADD CONSTRAINT "milestones_locked_version_id_contract_versions_id_fk" FOREIGN KEY ("locked_version_id") REFERENCES "core"."contract_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_contract_idx" ON "core"."audit_log" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contracts_client_idx" ON "core"."contracts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "contracts_freelancer_idx" ON "core"."contracts" USING btree ("freelancer_id");--> statement-breakpoint
CREATE INDEX "milestones_contract_idx" ON "core"."milestones" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "core"."outbox" USING btree ("occurred_at") WHERE published_at IS NULL;