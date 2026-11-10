"""Every AI verdict records its model, prompt, inputs and output (constitution VI, ADR-0010).

Revision ID: 0005
Revises: 0004
"""

from alembic import op

revision = "0005"
down_revision = "0004"


def upgrade() -> None:
    op.execute("""
    CREATE TABLE engine.ai_verdict_records (
      id uuid PRIMARY KEY,
      purpose text NOT NULL CHECK (purpose IN ('CRITERIA_SUGGESTION', 'AMBIGUITY_DETECTION',
                                               'CRITERION_EVALUATION', 'REPORT_SUMMARY')),
      run_id uuid REFERENCES engine.verification_runs (id),
      criterion_id uuid,                   -- no foreign key: criteria belong to Core (SB-3)
      model text NOT NULL,
      prompt_id text NOT NULL,
      prompt_version text NOT NULL,
      input_hashes jsonb NOT NULL,
      -- NULL when the model refused or never produced valid output: invalid output is not kept
      -- as if it were a verdict.
      output jsonb,
      validation text NOT NULL CHECK (validation IN ('VALID', 'INVALID_RETRIED',
                                                     'INVALID_FAILED', 'REFUSED')),
      usage jsonb NOT NULL,
      latency_ms integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT output_when_valid
        CHECK ((output IS NOT NULL) = (validation IN ('VALID', 'INVALID_RETRIED')))
    );
    CREATE TRIGGER ai_verdict_records_append_only
      BEFORE UPDATE OR DELETE ON engine.ai_verdict_records
      FOR EACH ROW EXECUTE FUNCTION engine.forbid_change();

    ALTER TABLE engine.criterion_results
      ADD COLUMN ai_verdict_record_id uuid,
      ADD COLUMN injection_flags jsonb NOT NULL DEFAULT '[]';
    """)


def downgrade() -> None:
    op.execute("""
    ALTER TABLE engine.criterion_results
      DROP COLUMN ai_verdict_record_id,
      DROP COLUMN injection_flags;
    DROP TABLE engine.ai_verdict_records;
    """)
