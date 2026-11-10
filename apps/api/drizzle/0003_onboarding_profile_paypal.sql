ALTER TABLE "core"."users" ADD COLUMN "clerk_user_id" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "account_type" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "business_name" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "paypal_payments_receivable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "paypal_payer_id" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "paypal_email" text;--> statement-breakpoint
ALTER TABLE "core"."users" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id");--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_account_type_ck" CHECK (account_type IS NULL OR account_type IN ('INDIVIDUAL', 'BUSINESS'));--> statement-breakpoint
ALTER TABLE "core"."users" ADD CONSTRAINT "users_country_ck" CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');--> statement-breakpoint
-- DM-INV-8 grandfathering: users that existed before onboarding (seeded dev and demo users)
-- count as onboarded, or every existing contract flow would start answering 403. Sellers that
-- already had a merchant id were set up by hand as able to receive payments.
UPDATE "core"."users" SET "onboarding_completed_at" = "created_at", "paypal_payments_receivable" = ("paypal_merchant_id" IS NOT NULL);
