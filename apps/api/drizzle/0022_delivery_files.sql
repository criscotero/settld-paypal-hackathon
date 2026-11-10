CREATE TABLE "core"."delivery_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"file_hash" text NOT NULL,
	"name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"entry_count" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_files_milestone_hash_uq" UNIQUE("milestone_id","file_hash"),
	CONSTRAINT "delivery_files_hash_ck" CHECK (file_hash ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "delivery_files_size_ck" CHECK (size_bytes BETWEEN 1 AND 26214400)
);
--> statement-breakpoint
ALTER TABLE "core"."delivery_files" ADD CONSTRAINT "delivery_files_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "core"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."delivery_files" ADD CONSTRAINT "delivery_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;