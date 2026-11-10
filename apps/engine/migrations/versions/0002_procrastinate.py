"""Procrastinate 3.10.0 tables and functions in the `engine` schema (ADR-0008 decision 1).

Revision ID: 0002
Revises: 0001

The SQL is the library's schema.sql, copied once and committed, like pg-boss in Core's 0006: a
library upgrade must never change what an applied migration means. Upgrading Procrastinate
means a new migration from its sql/migrations/ folder. engine_app's search_path is `engine`
(infra/postgres/init), so the unqualified names land there.
"""

from pathlib import Path

from alembic import op

revision = "0002"
down_revision = "0001"

SQL = Path(__file__).parent.parent / "sql" / "procrastinate-3.10.0.sql"


def upgrade() -> None:
    # The plpgsql bodies are full of colons and percent signs. op.execute would parse them as
    # :name bind parameters, and exec_driver_sql passes an empty parameter list, which makes
    # psycopg parse % as placeholders. The DBAPI cursor with no parameters sends the text as is,
    # on the same connection, so still inside this migration's transaction.
    cursor = op.get_bind().connection.dbapi_connection.cursor()  # type: ignore[union-attr]
    cursor.execute(SQL.read_text())
