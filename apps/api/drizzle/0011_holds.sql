CREATE TABLE "core"."holds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"payee_user_id" uuid NOT NULL,
	"payee_merchant_id" text NOT NULL,
	"position" integer NOT NULL,
	"share_bps" integer NOT NULL,
	"funded_minor" bigint DEFAULT 0 NOT NULL,
	"released_minor" bigint DEFAULT 0 NOT NULL,
	"returned_minor" bigint DEFAULT 0 NOT NULL,
	"hold_status" text DEFAULT 'NONE' NOT NULL,
	"paypal_order_id" text,
	"approve_url" text,
	"authorization_id" text,
	"authorized_at" timestamp with time zone,
	"authorization_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holds_milestone_payee_uq" UNIQUE("milestone_id","payee_user_id"),
	CONSTRAINT "holds_milestone_position_uq" UNIQUE("milestone_id","position"),
	CONSTRAINT "holds_status_ck" CHECK (hold_status IN ('NONE', 'ORDER_CREATED', 'AUTHORIZED', 'CAPTURE_PENDING', 'CAPTURED', 'CAPTURE_FAILED', 'VOID_PENDING', 'VOIDED', 'EXPIRED')),
	CONSTRAINT "holds_share_ck" CHECK (share_bps BETWEEN 1 AND 10000),
	CONSTRAINT "holds_conservation_ck" CHECK (funded_minor >= 0 AND released_minor >= 0 AND returned_minor >= 0 AND released_minor + returned_minor <= funded_minor)
);
--> statement-breakpoint
CREATE TABLE "core"."release_parts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"release_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"platform_fee_minor" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"capture_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_parts_release_hold_uq" UNIQUE("release_id","hold_id"),
	CONSTRAINT "release_parts_status_ck" CHECK (status IN ('PENDING', 'CAPTURED', 'FAILED')),
	CONSTRAINT "release_parts_amount_ck" CHECK (amount_minor > 0 AND platform_fee_minor >= 0 AND platform_fee_minor <= amount_minor)
);
--> statement-breakpoint
DROP INDEX "core"."payment_events_one_capture_uq";--> statement-breakpoint
ALTER TABLE "core"."payment_events" ADD COLUMN "hold_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."payment_events" ADD COLUMN "release_part_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holds" ADD CONSTRAINT "holds_payee_user_id_users_id_fk" FOREIGN KEY ("payee_user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."release_parts" ADD CONSTRAINT "release_parts_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "core"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."release_parts" ADD CONSTRAINT "release_parts_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "core"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_events" ADD CONSTRAINT "payment_events_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "core"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."payment_events" ADD CONSTRAINT "payment_events_release_part_id_release_parts_id_fk" FOREIGN KEY ("release_part_id") REFERENCES "core"."release_parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_one_capture_uq" ON "core"."payment_events" USING btree ("release_part_id") WHERE type = 'CAPTURED';