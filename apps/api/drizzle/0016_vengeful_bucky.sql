CREATE TABLE "core"."objection_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"objection_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "objection_messages_body_ck" CHECK (char_length(body) BETWEEN 1 AND 5000)
);
--> statement-breakpoint
ALTER TABLE "core"."objections" DROP CONSTRAINT "objections_status_ck";--> statement-breakpoint
ALTER TABLE "core"."objections" ADD COLUMN "escalate_at" timestamp with time zone;--> statement-breakpoint
-- Until now this was computed when reading. Same rule for what already exists (E-SCHEDULE-ESCALATION).
UPDATE "core"."objections" o SET "escalate_at" = LEAST(o."raised_at" + interval '5 days', COALESCE(m."authorization_expires_at" - interval '72 hours', o."raised_at" + interval '5 days')) FROM "core"."milestones" m WHERE m."id" = o."milestone_id";--> statement-breakpoint
ALTER TABLE "core"."objections" ALTER COLUMN "escalate_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."objections" ADD COLUMN "contested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."objections" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "core"."objections" ADD COLUMN "resolution_reason" text;--> statement-breakpoint
ALTER TABLE "core"."objection_messages" ADD CONSTRAINT "objection_messages_objection_id_objections_id_fk" FOREIGN KEY ("objection_id") REFERENCES "core"."objections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."objection_messages" ADD CONSTRAINT "objection_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "objection_messages_objection_idx" ON "core"."objection_messages" USING btree ("objection_id");--> statement-breakpoint
ALTER TABLE "core"."objections" ADD CONSTRAINT "objections_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."objections" ADD CONSTRAINT "objections_status_ck" CHECK (status IN ('OPEN', 'CONTESTED', 'ESCALATED', 'WITHDRAWN', 'SUPERSEDED_BY_RESUBMISSION', 'RULED_RELEASE', 'RULED_VOID', 'SURRENDERED'));