-- D4 (REQUIREMENTS_GAP.md): Client -> Buyer, Freelancer -> Seller.
-- RENAME instead of drop + add: the data stays where it is and Postgres only updates its
-- catalog, so the statement is instant and every foreign key keeps pointing at the same rows.
-- audit_log and outbox rows written before this keep the old values: they are history
-- (DM-INV-5 forbids rewriting the audit log anyway).
ALTER TABLE "core"."contracts" RENAME COLUMN "client_id" TO "buyer_id";--> statement-breakpoint
ALTER TABLE "core"."contracts" RENAME COLUMN "freelancer_id" TO "seller_id";--> statement-breakpoint
ALTER TABLE "core"."contracts" RENAME CONSTRAINT "contracts_client_id_users_id_fk" TO "contracts_buyer_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "core"."contracts" RENAME CONSTRAINT "contracts_freelancer_id_users_id_fk" TO "contracts_seller_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "core"."contracts_client_idx" RENAME TO "contracts_buyer_idx";--> statement-breakpoint
ALTER INDEX "core"."contracts_freelancer_idx" RENAME TO "contracts_seller_idx";--> statement-breakpoint
-- The CHECK has to go first: while it exists, 'BUYER' is not an allowed value.
ALTER TABLE "core"."contract_approvals" DROP CONSTRAINT "contract_approvals_role_ck";--> statement-breakpoint
UPDATE "core"."contract_approvals" SET "party_role" = CASE "party_role" WHEN 'CLIENT' THEN 'BUYER' WHEN 'FREELANCER' THEN 'SELLER' ELSE "party_role" END;--> statement-breakpoint
ALTER TABLE "core"."contract_approvals" ADD CONSTRAINT "contract_approvals_role_ck" CHECK (party_role IN ('BUYER', 'SELLER'));--> statement-breakpoint
UPDATE "core"."users" SET "roles" = array_replace(array_replace("roles", 'CLIENT', 'BUYER'), 'FREELANCER', 'SELLER');
