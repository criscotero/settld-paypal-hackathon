# createRun (internal-api.yaml): store the RunRequest and enqueue its start, in one transaction.
import hashlib
import json
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from settld_engine import jobs
from settld_engine.contracts import RunRequest, RunStatus


class RunConflictError(Exception):
    """Same runId (or submission) with a different body: 409 IDEMPOTENCY_KEY_REUSED."""


def canonical(value: Any) -> bytes:
    # Sorted keys, no whitespace: two bodies that mean the same thing hash the same, whatever
    # order Core serialized the fields in.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


async def create_run(
    db: AsyncEngine, request: RunRequest, correlation_id: str
) -> tuple[RunStatus, bool]:
    """Returns the run's status and whether this call created it (202) or found it (200)."""
    body = request.model_dump(mode="json", by_alias=True)
    request_hash = sha256(canonical(body))
    try:
        async with db.begin() as conn:
            # ON CONFLICT DO NOTHING, not SELECT-then-INSERT: two PUTs racing on the same runId
            # both pass a SELECT. Here the second INSERT waits on the first one's unique index
            # entry, then finds the row and returns nothing, so exactly one run and one job.
            inserted = await conn.execute(
                text("""
                INSERT INTO engine.verification_runs
                  (id, submission_id, milestone_id, contract_id, request, request_hash, deadline_at,
                   correlation_id)
                VALUES (:id, :submission_id, :milestone_id, :contract_id, CAST(:request AS jsonb),
                        :request_hash, :deadline_at, :correlation_id)
                ON CONFLICT (id) DO NOTHING
                RETURNING id
                """),
                {
                    "id": request.run_id,
                    "submission_id": request.submission_id,
                    "milestone_id": request.milestone_id,
                    "contract_id": request.contract_id,
                    "request": canonical(body).decode(),
                    "request_hash": request_hash,
                    "deadline_at": request.deadline_at,
                    "correlation_id": correlation_id,
                },
            )
            if inserted.first() is not None:
                await jobs.defer(
                    conn,
                    jobs.START,
                    {"runId": str(request.run_id)},
                    queueing_lock=f"run:{request.run_id}",
                )
                return RunStatus(run_id=request.run_id, status="QUEUED"), True

            existing = (
                await conn.execute(
                    text(
                        "SELECT request_hash, status, outcome FROM engine.verification_runs "
                        "WHERE id = :id"
                    ),
                    {"id": request.run_id},
                )
            ).one()
    except IntegrityError as error:
        # The other unique key: a new runId for a submission that already has a run. Core
        # generates runId once per submission, so this is a Core bug, never a retry.
        raise RunConflictError(f"submission {request.submission_id} already has a run") from error

    if existing.request_hash != request_hash:
        raise RunConflictError(f"run {request.run_id} exists with a different request")
    return RunStatus(run_id=request.run_id, status=existing.status, outcome=existing.outcome), False


async def get_run_report(db: AsyncEngine, run_id: UUID) -> dict[str, Any] | None:
    """getRun (internal-api.yaml): the Evidence Report, or what there is of it while running.

    A finished run returns the report exactly as finalize hashed it, plus that hash, so a reader
    can recompute it. Building it again here could drift from what the completion event cited.
    """
    async with db.connect() as conn:
        row = (
            await conn.execute(
                text("""
                SELECT id, milestone_id, request, status, outcome, started_at, report,
                       report_hash
                FROM engine.verification_runs WHERE id = :id
                """),
                {"id": run_id},
            )
        ).first()
    if row is None:
        return None
    if row.report is not None:
        report: dict[str, Any] = {**row.report, "reportHash": row.report_hash}
        return report
    return {
        "runId": str(row.id),
        "milestoneId": str(row.milestone_id),
        "attempt": row.request["attempt"],
        "status": row.status,
        "outcome": None,
        "startedAt": row.started_at.isoformat() if row.started_at else None,
        "finishedAt": None,
        "results": [],
        "reportHash": None,
    }
