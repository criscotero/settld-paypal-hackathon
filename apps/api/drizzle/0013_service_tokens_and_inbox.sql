CREATE TABLE "core"."inbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "inbox_provider_event_uq" UNIQUE("provider","external_event_id"),
	CONSTRAINT "inbox_provider_ck" CHECK (provider IN ('PAYPAL', 'GITHUB', 'ENGINE')),
	CONSTRAINT "inbox_verified_ck" CHECK (signature_verified)
);
--> statement-breakpoint
CREATE TABLE "core"."service_token_jti" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "service_token_jti_expires_idx" ON "core"."service_token_jti" USING btree ("expires_at");