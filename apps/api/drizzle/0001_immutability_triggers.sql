-- Invariants the database enforces itself, so no code path (a bug, a script, a manual
-- psql session as core_app) can break them. The application never relies on these to
-- behave correctly; they exist to turn a silent corruption into a loud error.

-- DM-INV-2: once a version has a hash (PENDING_APPROVAL or later), its snapshot and hash
-- never change and the row is never deleted. Status may still move forward
-- (PENDING_APPROVAL -> LOCKED or SUPERSEDED).
CREATE FUNCTION core.forbid_frozen_version_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.snapshot_hash IS NOT NULL THEN
      RAISE EXCEPTION 'DM-INV-2: version % is frozen and cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.snapshot_hash IS NOT NULL
     AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash) THEN
    RAISE EXCEPTION 'DM-INV-2: version % is frozen; its snapshot and hash cannot change', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contract_versions_frozen
BEFORE UPDATE OR DELETE ON core.contract_versions
FOR EACH ROW EXECUTE FUNCTION core.forbid_frozen_version_change();
--> statement-breakpoint

-- DM-INV-5: the audit log is insert-only. REVOKE would not be enough here: core_app owns
-- the table, and an owner can always grant itself the privilege back.
CREATE FUNCTION core.forbid_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DM-INV-5: audit_log is append-only (% refused)', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON core.audit_log
FOR EACH ROW EXECUTE FUNCTION core.forbid_audit_change();
--> statement-breakpoint
-- TRUNCATE bypasses row triggers, so it needs its own statement-level trigger.
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON core.audit_log
FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_audit_change();
