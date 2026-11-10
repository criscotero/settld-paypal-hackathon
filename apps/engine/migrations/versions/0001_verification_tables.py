"""Verification runs, criterion results, evidence snapshots and the Engine outbox (ADR-0008).

Revision ID: 0001
Revises:
"""

from alembic import op

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.execute("""
    -- One row per RunRequest. The primary key is Core's runId, so a retried PUT cannot create
    -- a second run: idempotency comes from the key, not from a check-then-insert.
    CREATE TABLE engine.verification_runs (
      id uuid PRIMARY KEY,
      submission_id uuid NOT NULL UNIQUE,  -- one run per submission in the MVP
      milestone_id uuid NOT NULL,
      contract_id uuid NOT NULL,
      -- The RunRequest as validated: everything the run needs (SB-4). Its hash tells a replay
      -- (same body, 200) from a conflict (different body, 409).
      request jsonb NOT NULL,
      request_hash text NOT NULL,
      status text NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'TIMED_OUT')),
      outcome text CHECK (outcome IN ('PASSED', 'FAILED')),
      deadline_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      report jsonb,
      report_hash text CHECK (report_hash ~ '^sha256:[0-9a-f]{64}$'),
      last_seq integer NOT NULL DEFAULT 0, -- events.md: seq increases per run
      correlation_id text NOT NULL,        -- X-Request-Id of the createRun call; on every event
      created_at timestamptz NOT NULL DEFAULT now(),
      -- A finished run always has an outcome and a report; an unfinished one never does.
      CONSTRAINT finished_has_outcome CHECK (
        (status IN ('COMPLETED', 'TIMED_OUT')) = (outcome IS NOT NULL AND report_hash IS NOT NULL
                                                  AND finished_at IS NOT NULL)
      )
    );

    -- Evidence is written in the same transaction as the result that cites it, so there is no
    -- snapshot without a verdict and no verdict without its snapshots.
    CREATE TABLE engine.evidence_snapshots (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES engine.verification_runs (id),
      criterion_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('PR_METADATA', 'CI_RUN', 'TEST_REPORT', 'HTTP_RESPONSE',
                                         'SCREENSHOT', 'DIFF', 'NOTES')),
      -- ADR-0008 decision 3: bytes in Postgres for the hackathon, S3 with Object Lock later.
      content bytea NOT NULL,
      content_type text NOT NULL,
      source_url text,
      -- The database recomputes the hash: a bug that stored the wrong hash, or bytes changed
      -- by hand, fails here instead of producing evidence that does not match its hash (VII).
      hash text NOT NULL
        CONSTRAINT hash_matches_content CHECK (hash = 'sha256:' || encode(sha256(content), 'hex')),
      captured_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE engine.criterion_results (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES engine.verification_runs (id),
      criterion_id uuid NOT NULL,
      verdict text NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'UNCERTAIN', 'NEEDS_HUMAN')),
      reason text NOT NULL,
      evidence_refs uuid[] NOT NULL DEFAULT '{}',
      source text NOT NULL CHECK (source IN ('ADAPTER', 'AI')),
      duration_ms integer NOT NULL DEFAULT 0,
      attempts integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      -- A check that runs twice (retry, kill -9 after commit) cannot store two verdicts.
      UNIQUE (run_id, criterion_id),
      -- DM-INV-4: a PASS always points at evidence.
      CONSTRAINT pass_has_evidence CHECK (verdict <> 'PASS' OR cardinality(evidence_refs) >= 1)
    );

    -- Events for Core API (SB-6). Written in the same transaction as the fact they report;
    -- engine.outbox.dispatch delivers them until Core acknowledges.
    CREATE TABLE engine.outbox (
      -- The event id Core deduplicates on (events.md: UUIDv7).
      id uuid PRIMARY KEY DEFAULT uuidv7(),
      run_id uuid REFERENCES engine.verification_runs (id),
      type text NOT NULL,
      envelope jsonb NOT NULL,             -- the full EngineEvent, exactly as it will be sent
      created_at timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text
    );
    CREATE INDEX outbox_undelivered ON engine.outbox (next_attempt_at) WHERE delivered_at IS NULL;

    -- Evidence and verdicts are append-only. TRUNCATE (tests) does not fire row triggers.
    CREATE FUNCTION engine.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END;
    $$;
    CREATE TRIGGER evidence_snapshots_append_only
      BEFORE UPDATE OR DELETE ON engine.evidence_snapshots
      FOR EACH ROW EXECUTE FUNCTION engine.forbid_change();
    CREATE TRIGGER criterion_results_append_only
      BEFORE UPDATE OR DELETE ON engine.criterion_results
      FOR EACH ROW EXECUTE FUNCTION engine.forbid_change();
    """)
