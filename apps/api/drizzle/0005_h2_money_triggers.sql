-- Money invariants the database enforces itself (same idea as 0001): no code path can
-- break them silently. The service never relies on these to be correct.

-- DM-INV-5: payment_events is the ledger that mirrors PayPal. A fact, once recorded, is
-- never edited or removed; a correction is a new event.
CREATE FUNCTION core.forbid_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DM-INV-5: payment_events is append-only (% refused)', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_events_append_only
BEFORE UPDATE OR DELETE ON core.payment_events
FOR EACH ROW EXECUTE FUNCTION core.forbid_ledger_change();
--> statement-breakpoint
CREATE TRIGGER payment_events_no_truncate
BEFORE TRUNCATE ON core.payment_events
FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_ledger_change();
--> statement-breakpoint

-- SM-INV-10: released money is never taken back by the state machine. A later run that
-- counts fewer criteria releases nothing; it does not lower released_minor.
CREATE FUNCTION core.forbid_release_decrease() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.released_minor < OLD.released_minor THEN
    RAISE EXCEPTION 'SM-INV-10: released_minor of milestone % cannot decrease (% -> %)', OLD.id, OLD.released_minor, NEW.released_minor;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER milestones_release_monotonic
BEFORE UPDATE OF released_minor ON core.milestones
FOR EACH ROW EXECUTE FUNCTION core.forbid_release_decrease();
