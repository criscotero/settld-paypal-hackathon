-- Removes the invented demo history added by apps/api/src/db/seed-demo-history.cli.ts, and only that:
-- every row it wrote has an id ending in de0de0de0de0. Run as the database owner, because the
-- immutability triggers are switched off for this one transaction.
--   docker exec -i settld-postgres-1 psql -U postgres -d settld -v ON_ERROR_STOP=1 < scripts/demo_history_undo.sql
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM core.release_parts WHERE id::text LIKE '%de0de0de0de0';
DELETE FROM core.releases WHERE id::text LIKE '%de0de0de0de0';
DELETE FROM core.holds WHERE id::text LIKE '%de0de0de0de0';
DELETE FROM core.submissions WHERE id::text LIKE '%de0de0de0de0';
DELETE FROM core.contract_approvals a USING core.contract_versions v WHERE a.contract_version_id = v.id AND v.id::text LIKE '%de0de0de0de0';
DELETE FROM core.contract_parties WHERE contract_id::text LIKE '%de0de0de0de0';
DELETE FROM core.milestones WHERE id::text LIKE '%de0de0de0de0';
DELETE FROM core.contract_versions WHERE id::text LIKE '%de0de0de0de0';
DELETE FROM core.contracts WHERE id::text LIKE '%de0de0de0de0';
DELETE FROM core.users WHERE id::text LIKE '%de0de0de0de0';
COMMIT;
