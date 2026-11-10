-- SM-INV-10, 1.1.0: released_minor never decreases, except when PayPal declines a partial
-- release (the money never moved). The service says so explicitly, inside the transaction
-- that records the decline: SET LOCAL settld.release_revert = 'on'. SET LOCAL ends with the
-- transaction, so the permission cannot leak into any other write.
CREATE OR REPLACE FUNCTION core.forbid_release_decrease() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.released_minor < OLD.released_minor
     AND current_setting('settld.release_revert', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SM-INV-10: released_minor of milestone % cannot decrease (% -> %)', OLD.id, OLD.released_minor, NEW.released_minor;
  END IF;
  RETURN NEW;
END;
$$;
