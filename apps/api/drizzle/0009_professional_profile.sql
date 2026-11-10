ALTER TABLE "core"."users" ADD COLUMN "headline" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "professions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "skills" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "link" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "in_directory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "professional_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_professions_ck" CHECK (professions <@ ARRAY['PRODUCT_DESIGNER', 'SOFTWARE_DEVELOPER', 'AI_ENGINEER', 'DATA_ANALYST', 'QA_ENGINEER', 'PRODUCT_MANAGER', 'COPYWRITER', 'DEVOPS_ENGINEER', 'OTHER']::text[] AND cardinality(professions) <= 5);--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_skills_ck" CHECK (cardinality(skills) <= 12);--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_link_ck" CHECK (link IS NULL OR link ~ '^https://');