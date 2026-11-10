"""Outbox events Core refused for good (422) are parked for a person, not retried.

Revision ID: 0004
Revises: 0003
"""

from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade() -> None:
    op.execute("""
    ALTER TABLE engine.outbox ADD COLUMN parked_at timestamptz;
    -- The dispatcher only ever looks at events still to send: neither delivered nor parked.
    DROP INDEX engine.outbox_undelivered;
    CREATE INDEX outbox_due ON engine.outbox (next_attempt_at)
      WHERE delivered_at IS NULL AND parked_at IS NULL;
    """)


def downgrade() -> None:
    op.execute("""
    DROP INDEX engine.outbox_due;
    CREATE INDEX outbox_undelivered ON engine.outbox (next_attempt_at) WHERE delivered_at IS NULL;
    ALTER TABLE engine.outbox DROP COLUMN parked_at;
    """)
