-- ADR-0009: the money of a milestone lives in its holds. Same idea as 0005 and 0008: the
-- database refuses what the service must never do, so a bug becomes a rollback instead of a
-- ledger that disagrees with PayPal.

-- Milestones funded before ADR-0009 were paid to the seller alone: they become a team of one,
-- so every milestone follows the same rules from here on. Their old ledger rows keep
-- hold_id null (DM-INV-5: the ledger is never edited).
INSERT INTO core.holds (milestone_id, payee_user_id, payee_merchant_id, position, share_bps,
  funded_minor, released_minor, returned_minor, hold_status, paypal_order_id,
  authorization_id, authorized_at, authorization_expires_at)
SELECT m.id, c.seller_id, coalesce(u.paypal_merchant_id, ''), 0, 10000,
  m.funded_minor, m.released_minor, m.returned_minor, m.hold_status, m.paypal_order_id,
  m.authorization_id, m.authorized_at, m.authorization_expires_at
FROM core.milestones m
JOIN core.contracts c ON c.id = m.contract_id
JOIN core.users u ON u.id = c.seller_id
WHERE m.hold_status <> 'NONE';
--> statement-breakpoint
INSERT INTO core.release_parts (release_id, hold_id, amount_minor, platform_fee_minor, status, capture_id, updated_at)
SELECT r.id, h.id, r.amount_minor, r.platform_fee_minor, r.status, r.capture_id, r.updated_at
FROM core.releases r
JOIN core.holds h ON h.milestone_id = r.milestone_id;
--> statement-breakpoint

-- SM-INV-10 per hold: released_minor never decreases, except when PayPal declines a partial
-- release, inside the transaction that records it (SET LOCAL settld.release_revert, as in 0008).
CREATE FUNCTION core.forbid_hold_release_decrease() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.released_minor < OLD.released_minor
     AND current_setting('settld.release_revert', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SM-INV-10: released_minor of hold % cannot decrease (% -> %)', OLD.id, OLD.released_minor, NEW.released_minor;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER holds_release_monotonic
BEFORE UPDATE OF released_minor ON core.holds
FOR EACH ROW EXECUTE FUNCTION core.forbid_hold_release_decrease();
--> statement-breakpoint

-- SM-INV-9 across tables: a milestone's funded, released and returned are the sums of its holds.
-- A CHECK cannot look at another table, so this is a constraint trigger. DEFERRABLE INITIALLY
-- DEFERRED: it runs at COMMIT, not after each statement, because a transition updates the holds
-- and then the milestone, and in between the two legitimately disagree.
CREATE FUNCTION core.check_milestone_matches_holds() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mid uuid;
  m core.milestones%ROWTYPE;
  f bigint;
  r bigint;
  t bigint;
BEGIN
  -- Two IFs, not one CASE: plpgsql prepares an expression for the row type it gets, and
  -- NEW.milestone_id does not exist on a milestones row.
  IF TG_TABLE_NAME = 'holds' THEN
    mid := NEW.milestone_id;
  ELSE
    mid := NEW.id;
  END IF;
  SELECT * INTO m FROM core.milestones WHERE id = mid;
  SELECT coalesce(sum(funded_minor), 0), coalesce(sum(released_minor), 0), coalesce(sum(returned_minor), 0)
    INTO f, r, t FROM core.holds WHERE milestone_id = mid;
  IF m.funded_minor <> f OR m.released_minor <> r OR m.returned_minor <> t THEN
    RAISE EXCEPTION 'SM-INV-9: milestone % has funded/released/returned %/%/% but its holds add up to %/%/%',
      mid, m.funded_minor, m.released_minor, m.returned_minor, f, r, t;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER milestones_match_holds
AFTER INSERT OR UPDATE OF funded_minor, released_minor, returned_minor ON core.milestones
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.check_milestone_matches_holds();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER holds_match_milestone
AFTER INSERT OR UPDATE OF funded_minor, released_minor, returned_minor ON core.holds
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.check_milestone_matches_holds();
