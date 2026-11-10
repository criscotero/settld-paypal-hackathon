"""Seen service-token ids, so a captured token cannot be replayed (service-boundaries.md, 3).

Revision ID: 0003
Revises: 0002
"""

from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    op.execute("""
    -- One row per accepted token. The primary key is the replay check: a second request with
    -- the same jti is a unique violation, decided by the database even across Engine instances.
    -- Rows only matter until the token expires (60 s), so expired ones are deleted as we go.
    CREATE TABLE engine.service_token_jti (
      jti text PRIMARY KEY,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX service_token_jti_expires ON engine.service_token_jti (expires_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE engine.service_token_jti")
