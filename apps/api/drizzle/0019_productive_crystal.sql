CREATE TABLE "core"."ai_suggestion_usage" (
	"day" date NOT NULL,
	"scope" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "ai_suggestion_usage_day_scope_pk" PRIMARY KEY("day","scope")
);
