CREATE TABLE "core"."contract_parties" (
	"contract_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"party_role" text DEFAULT 'COLLABORATOR' NOT NULL,
	"invited_by" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_parties_contract_id_user_id_pk" PRIMARY KEY("contract_id","user_id"),
	CONSTRAINT "contract_parties_role_ck" CHECK (party_role = 'COLLABORATOR')
);
--> statement-breakpoint
ALTER TABLE "core"."contract_approvals" DROP CONSTRAINT "contract_approvals_version_role_uq";--> statement-breakpoint
ALTER TABLE "core"."contract_approvals" DROP CONSTRAINT "contract_approvals_role_ck";--> statement-breakpoint
ALTER TABLE "core"."contract_parties" ADD CONSTRAINT "contract_parties_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "core"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_parties" ADD CONSTRAINT "contract_parties_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_parties" ADD CONSTRAINT "contract_parties_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_parties_user_idx" ON "core"."contract_parties" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "core"."contract_approvals" ADD CONSTRAINT "contract_approvals_version_user_uq" UNIQUE("contract_version_id","user_id");--> statement-breakpoint
ALTER TABLE "core"."contract_approvals" ADD CONSTRAINT "contract_approvals_role_ck" CHECK (party_role IN ('BUYER', 'SELLER', 'COLLABORATOR'));