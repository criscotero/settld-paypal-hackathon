CREATE TABLE "core"."reviewer_applications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"motivation" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewer_applications_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "reviewer_applications_status_ck" CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'))
);
--> statement-breakpoint
ALTER TABLE "core"."reviewer_applications" ADD CONSTRAINT "reviewer_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reviewer_applications" ADD CONSTRAINT "reviewer_applications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviewer_applications_status_idx" ON "core"."reviewer_applications" USING btree ("status");