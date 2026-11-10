ALTER TABLE "core"."contracts" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."contracts" ADD COLUMN "published_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."contracts" ADD COLUMN "taken_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "contracts_published_idx" ON "core"."contracts" USING btree ("published_at","id");