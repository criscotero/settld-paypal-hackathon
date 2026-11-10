"""A suggestion is a paid call a person asked for: the record says who (ADR-0016).

Revision ID: 0006
Revises: 0005
"""

from alembic import op

revision = "0006"
down_revision = "0005"


def upgrade() -> None:
    # No foreign key: users belong to Core (SB-3). Null on evaluations, which no person requests.
    op.execute("ALTER TABLE engine.ai_verdict_records ADD COLUMN requested_by uuid")


def downgrade() -> None:
    op.execute("ALTER TABLE engine.ai_verdict_records DROP COLUMN requested_by")
