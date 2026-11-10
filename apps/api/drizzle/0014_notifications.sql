CREATE TABLE "core"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"dedupe_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_status_ck" CHECK ("core"."notifications"."status" IN ('PENDING', 'SENT', 'SUPPRESSED'))
);
--> statement-breakpoint
ALTER TABLE "core"."notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;