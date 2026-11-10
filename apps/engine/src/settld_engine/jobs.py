# Enqueue Procrastinate jobs inside the caller's transaction (constitution IV, SB-6).
#
# Procrastinate's own defer opens its own connection, so a job deferred that way commits
# separately: kill -9 between the two commits leaves a run nobody starts, or a job for a run
# that rolled back. Calling the same SQL function Procrastinate calls (queries.sql, defer_jobs)
# on our connection makes the job a row of our transaction: both exist or neither does. It is
# the Python twin of PgBossJobScheduler.send(tx, ...) in Core.
#
# The coupling is to procrastinate_defer_jobs_v1, a versioned function: Procrastinate adds _v2
# instead of changing _v1, and the schema migration pins the version (migrations 0002).
import json
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

QUEUE = "verification"
QUEUEING_LOCK_INDEX = "procrastinate_jobs_queueing_lock_idx_v1"

# Task names from events.md section 3.2. The worker registers its tasks under the same names.
START = "engine.verification.start"
CHECK = "engine.verification.check"
FINALIZE = "engine.verification.finalize"
RETRY_STALLED = "engine.jobs.retry_stalled"
OUTBOX_DISPATCH = "engine.outbox.dispatch"

_DEFER = text("""
SELECT unnest(procrastinate_defer_jobs_v1(ARRAY[
  ROW(:queue, :task, 0, NULL, :queueing_lock, CAST(:args AS jsonb), :scheduled_at)
]::procrastinate_job_to_defer_v1[]))
""")


async def defer(
    conn: AsyncConnection,
    task: str,
    args: dict[str, Any],
    *,
    queueing_lock: str,
    scheduled_at: datetime | None = None,
) -> bool:
    """Enqueues a job in conn's transaction. False when the same queueing lock is still waiting.

    A queueing lock is unique among jobs not yet started, so a second defer of the same work is
    a no-op instead of a duplicate. The savepoint matters: a unique violation aborts the whole
    Postgres transaction, and the caller's run or result rows would roll back with it.
    """
    try:
        async with conn.begin_nested():
            await conn.execute(
                _DEFER,
                {
                    "queue": QUEUE,
                    "task": task,
                    "queueing_lock": queueing_lock,
                    "args": json.dumps(args),
                    "scheduled_at": scheduled_at,
                },
            )
    except IntegrityError as error:
        if QUEUEING_LOCK_INDEX in str(error.orig):
            return False
        raise
    return True
