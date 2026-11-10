"""The evaluator's checks, and the two evidence kinds its tools read (ADR-0019).

Revision ID: 0007
Revises: 0006
"""

from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    # Checks belong to the result they explain, written in the same INSERT, so a report can never
    # show a verdict without the checks it was computed from. Empty for every non-AI criterion.
    op.execute("ALTER TABLE engine.criterion_results ADD COLUMN checks jsonb NOT NULL DEFAULT '[]'")
    op.execute(
        "ALTER TABLE engine.evidence_snapshots DROP CONSTRAINT evidence_snapshots_kind_check"
    )
    op.execute("""
        ALTER TABLE engine.evidence_snapshots ADD CONSTRAINT evidence_snapshots_kind_check
        CHECK (kind IN ('PR_METADATA', 'CI_RUN', 'TEST_REPORT', 'HTTP_RESPONSE', 'SCREENSHOT',
                        'DIFF', 'NOTES', 'REPOSITORY_FILE', 'DELIVERED_FILE'))
    """)


def downgrade() -> None:
    op.execute(
        "ALTER TABLE engine.evidence_snapshots DROP CONSTRAINT evidence_snapshots_kind_check"
    )
    op.execute("""
        ALTER TABLE engine.evidence_snapshots ADD CONSTRAINT evidence_snapshots_kind_check
        CHECK (kind IN ('PR_METADATA', 'CI_RUN', 'TEST_REPORT', 'HTTP_RESPONSE', 'SCREENSHOT',
                        'DIFF', 'NOTES'))
    """)
    op.execute("ALTER TABLE engine.criterion_results DROP COLUMN checks")
