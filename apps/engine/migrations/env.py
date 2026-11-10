# Alembic runs as engine_app, which owns the `engine` schema and nothing else (SB-3).
# Migrations are hand-written SQL (op.execute), like Core's drizzle/ files: the schema is
# designed in SQL, with its constraints and triggers, not derived from Python models.
import os

from alembic import context
from sqlalchemy import create_engine

url = context.config.attributes.get("url") or os.environ["DATABASE_URL"]

with create_engine(url).connect() as connection:
    context.configure(
        connection=connection,
        # Without this the version table lands wherever search_path points; pinning it keeps
        # it in `engine` even if a superuser runs the migration.
        version_table_schema="engine",
        # One transaction per migration: a failure leaves nothing half-applied.
        transaction_per_migration=True,
    )
    with context.begin_transaction():
        context.run_migrations()
