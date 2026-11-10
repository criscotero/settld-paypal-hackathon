# The run orchestrator (verification-adapters.md section 4, ADR-0008): start, one check per
# criterion, finalize. Each step is a Procrastinate job (tasks.py) and each is idempotent, so a
# retry or a kill -9 at any line repeats work but never changes the result.
#
# Locking rule: every write takes the run row with FOR UPDATE first. That serializes the
# checks against each other and against finalize, so "are all results in?" and "is the run
# still open?" are answered on data nobody else is changing.
#
# The network call of a check happens with no transaction open. Holding the run lock for up to
# 45 s would block every other check of the run (the H2 lesson with PayPal captures).
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from pydantic import ValidationError
from sqlalchemy import Row, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from settld_engine import jobs
from settld_engine.contracts import InjectionFlag, RunCriterion, RunRequest, Verdict
from settld_engine.runs import canonical, sha256
from settld_engine.verification.adapters.base import (
    AdapterError,
    AiCall,
    CheckInput,
    CheckOutcome,
    EvidenceKind,
    SnapshotRef,
    Uncertain,
    VerificationAdapter,
)

Adapters = Mapping[str, VerificationAdapter[Any]]

NOT_AVAILABLE = "this type of check is not available yet; the buyer can approve it by hand"


class RetryCheckError(Exception):
    """A transient adapter error with attempts left: Procrastinate runs the job again."""


@dataclass
class _Snapshot:
    id: UUID
    kind: EvidenceKind
    data: bytes
    hash: str
    content_type: str
    source_url: str | None


@dataclass
class BufferedContext:
    """CheckContext that keeps snapshots in memory until the result is stored.

    Snapshots and the result that cites them commit together. Writing snapshots as the adapter
    goes would leave orphans on every retry and kill -9, and evidence nobody judged.
    """

    deadline: datetime
    snapshots: list[_Snapshot] = field(default_factory=list)
    ai_call: AiCall | None = None

    async def snapshot(
        self, kind: EvidenceKind, data: bytes, *, content_type: str, source_url: str | None = None
    ) -> SnapshotRef:
        snap = _Snapshot(uuid4(), kind, data, sha256(data), content_type, source_url)
        self.snapshots.append(snap)
        return SnapshotRef(id=snap.id, hash=snap.hash)

    def record_ai(self, call: AiCall) -> None:
        self.ai_call = call

    async def github_token(self, repository: str) -> str:
        raise NotImplementedError("no GitHub adapter in the hackathon (ADR-0008 decision 4)")


async def _lock_run(conn: AsyncConnection, run_id: UUID) -> Row[Any] | None:
    result = await conn.execute(
        text("SELECT * FROM engine.verification_runs WHERE id = :id FOR UPDATE"), {"id": run_id}
    )
    return result.first()


async def _store_result(
    conn: AsyncConnection,
    run_id: UUID,
    criterion_id: UUID,
    verdict: Verdict,
    reason: str,
    *,
    evidence: list[_Snapshot] | None = None,
    duration_ms: int = 0,
    attempts: int = 1,
    ai_call: AiCall | None = None,
    injection_flags: list[InjectionFlag] | None = None,
    checks: list[dict[str, Any]] | None = None,
) -> bool:
    evidence = evidence or []
    # The id is ours, not the database's, so the result can name the record it came from without
    # a second write: criterion_results is append-only.
    ai_record_id = uuid4() if ai_call is not None else None
    stored = await conn.execute(
        text("""
        INSERT INTO engine.criterion_results
          (run_id, criterion_id, verdict, reason, evidence_refs, source, duration_ms, attempts,
           ai_verdict_record_id, injection_flags, checks)
        VALUES (:run_id, :criterion_id, :verdict, :reason, CAST(:refs AS uuid[]), :source,
                :duration_ms, :attempts, :ai_record_id, CAST(:flags AS jsonb),
                CAST(:checks AS jsonb))
        ON CONFLICT (run_id, criterion_id) DO NOTHING
        RETURNING id
        """),
        {
            "source": "AI" if ai_call is not None else "ADAPTER",
            "ai_record_id": ai_record_id,
            "flags": json.dumps(
                [f.model_dump(mode="json", by_alias=True) for f in injection_flags or []]
            ),
            "checks": json.dumps(checks or []),
            "run_id": run_id,
            "criterion_id": criterion_id,
            "verdict": verdict,
            "reason": reason,
            "refs": [str(s.id) for s in evidence],
            "duration_ms": duration_ms,
            "attempts": attempts,
        },
    )
    if stored.first() is None:
        return False  # an earlier attempt already stored this verdict; keep the first
    for snap in evidence:
        await conn.execute(
            text("""
            INSERT INTO engine.evidence_snapshots
              (id, run_id, criterion_id, kind, content, content_type, source_url, hash)
            VALUES (:id, :run_id, :criterion_id, :kind, :content, :content_type, :source_url, :hash)
            """),
            {
                "id": snap.id,
                "run_id": run_id,
                "criterion_id": criterion_id,
                "kind": snap.kind,
                "content": snap.data,
                "content_type": snap.content_type,
                "source_url": snap.source_url,
                "hash": snap.hash,
            },
        )
    if ai_call is not None:
        await conn.execute(
            text("""
            INSERT INTO engine.ai_verdict_records
              (id, purpose, run_id, criterion_id, model, prompt_id, prompt_version, input_hashes,
               output, validation, usage, latency_ms)
            VALUES (:id, 'CRITERION_EVALUATION', :run_id, :criterion_id, :model, :prompt_id,
                    :prompt_version, CAST(:input_hashes AS jsonb), CAST(:output AS jsonb),
                    :validation, CAST(:usage AS jsonb), :latency_ms)
            """),
            {
                "id": ai_record_id,
                "run_id": run_id,
                "criterion_id": criterion_id,
                "model": ai_call.model,
                "prompt_id": ai_call.prompt_id,
                "prompt_version": ai_call.prompt_version,
                "input_hashes": json.dumps(ai_call.input_hashes),
                "output": None if ai_call.output is None else json.dumps(ai_call.output),
                "validation": ai_call.validation,
                "usage": json.dumps(ai_call.usage),
                "latency_ms": ai_call.latency_ms,
            },
        )
    return True


async def _defer_finalize_if_complete(
    conn: AsyncConnection, run_id: UUID, request: RunRequest
) -> None:
    done = (
        await conn.execute(
            text("SELECT count(*) FROM engine.criterion_results WHERE run_id = :id"), {"id": run_id}
        )
    ).scalar_one()
    if done == len(request.criteria):
        await jobs.defer(
            conn, jobs.FINALIZE, {"runId": str(run_id)}, queueing_lock=f"finalize:{run_id}"
        )


def _needs_adapter(criterion: RunCriterion, adapters: Adapters) -> bool:
    return criterion.level != "HUMAN" and criterion.check_type in adapters


async def start_run(db: AsyncEngine, adapters: Adapters, run_id: UUID) -> None:
    async with db.begin() as conn:
        run = await _lock_run(conn, run_id)
        if run is None or run.status != "QUEUED":
            return  # already started: this is a retry of a start that committed
        request = RunRequest.model_validate(run.request)
        await conn.execute(
            text(
                "UPDATE engine.verification_runs SET status = 'RUNNING', started_at = now() "
                "WHERE id = :id"
            ),
            {"id": run_id},
        )
        for criterion in request.criteria:
            if criterion.level == "HUMAN":
                # Constitution VI and D7: subjective criteria are decided by the buyer, never by
                # the Engine. NEEDS_HUMAN never counts as PASS.
                await _store_result(
                    conn,
                    run_id,
                    criterion.criterion_id,
                    "NEEDS_HUMAN",
                    "the buyer decides it during the countdown",
                )
            elif not _needs_adapter(criterion, adapters):
                # ADR-0008 decision 4: no adapter yet means UNCERTAIN, which the buyer can approve.
                await _store_result(
                    conn, run_id, criterion.criterion_id, "UNCERTAIN", NOT_AVAILABLE
                )
            else:
                await jobs.defer(
                    conn,
                    jobs.CHECK,
                    {"runId": str(run_id), "criterionId": str(criterion.criterion_id)},
                    queueing_lock=f"check:{run_id}:{criterion.criterion_id}",
                )
        # The deadline is the backstop for every failure below this line: a check that hangs,
        # crashes on every attempt, or whose worker died. Its own lock name, so it never
        # collides with the immediate finalize deferred when the last result lands.
        await jobs.defer(
            conn,
            jobs.FINALIZE,
            {"runId": str(run_id)},
            queueing_lock=f"deadline:{run_id}",
            scheduled_at=request.deadline_at,
        )
        await _defer_finalize_if_complete(conn, run_id, request)


async def check_criterion(
    db: AsyncEngine, adapters: Adapters, run_id: UUID, criterion_id: UUID, previous_attempts: int
) -> None:
    async with db.connect() as conn:
        run = (
            await conn.execute(
                text(
                    "SELECT status, request, deadline_at FROM engine.verification_runs "
                    "WHERE id = :id"
                ),
                {"id": run_id},
            )
        ).first()
        if run is None or run.status != "RUNNING":
            return
        already = await conn.execute(
            text("SELECT 1 FROM engine.criterion_results WHERE run_id = :r AND criterion_id = :c"),
            {"r": run_id, "c": criterion_id},
        )
        if already.first() is not None:
            return  # kill -9 after the commit: the result is in, nothing to redo
    request = RunRequest.model_validate(run.request)
    criterion = next(c for c in request.criteria if c.criterion_id == criterion_id)
    check_type = criterion.check_type
    if check_type is None:  # start_run only defers checks for criteria with an adapter
        raise ValueError(f"criterion {criterion_id} has no check type")
    adapter = adapters[check_type]
    ctx = BufferedContext(deadline=run.deadline_at)

    started = time.monotonic()
    outcome: CheckOutcome
    try:
        config = adapter.config_model.model_validate(criterion.check_config or {})
    except ValidationError as error:
        # The config was approved in the contract, so this is a Core/Engine schema mismatch.
        # Retrying cannot fix it; the buyer can still approve by hand.
        outcome = Uncertain(
            reason=f"invalid check config: {error.error_count()} errors", evidence_refs=[]
        )
    else:
        check = CheckInput[Any](
            run_id=run_id,
            criterion_id=criterion_id,
            criterion_text=criterion.text,
            check_type=check_type,
            config=config,
            evidence_links=request.evidence_links,
            notes=request.notes,
            locale=request.locale,
        )
        outcome = await adapter.execute(check, ctx)
    duration_ms = round((time.monotonic() - started) * 1000)

    attempts = previous_attempts + 1
    if isinstance(outcome, AdapterError):
        if outcome.retryable and attempts < adapter.policy.max_attempts:
            raise RetryCheckError(outcome.reason)
        # verification-adapters.md: ERROR never reaches a CriterionResult.
        outcome = Uncertain(
            reason=f"could not check after {attempts} attempts: {outcome.reason}", evidence_refs=[]
        )

    async with db.begin() as conn:
        locked = await _lock_run(conn, run_id)
        if locked is None or locked.status != "RUNNING":
            # Finalize won the race (deadline): the criterion is already UNCERTAIN in the report
            # Core received. Storing a late PASS now would contradict it, so it is dropped.
            return
        stored = await _store_result(
            conn,
            run_id,
            criterion_id,
            outcome.verdict,
            outcome.reason,
            evidence=ctx.snapshots,
            duration_ms=duration_ms,
            attempts=attempts,
            ai_call=ctx.ai_call,
            injection_flags=outcome.injection_flags,
            checks=outcome.checks,
        )
        if stored:
            for flag in outcome.injection_flags:
                await _emit(
                    conn,
                    locked,
                    "verification.injection.flagged",
                    {
                        "runId": str(run_id),
                        "criterionId": str(criterion_id),
                        "evidenceSnapshotId": str(flag.evidence_snapshot_id),
                        # The hash, not the text: the excerpt is seller content, and this event
                        # travels further than the report that shows it to the parties.
                        "excerptHash": sha256(flag.excerpt.encode()),
                    },
                    actor=jobs.CHECK,
                    now=datetime.now(UTC),
                )
            await _defer_finalize_if_complete(conn, run_id, request)


async def finalize_run(db: AsyncEngine, run_id: UUID, *, now: datetime | None = None) -> None:
    now = now or datetime.now(UTC)
    async with db.begin() as conn:
        run = await _lock_run(conn, run_id)
        # QUEUED is allowed: if no worker picked up the start before the deadline, the run
        # still ends, with every criterion UNCERTAIN, instead of staying open forever.
        if run is None or run.status not in ("QUEUED", "RUNNING"):
            return
        request = RunRequest.model_validate(run.request)
        rows = (
            await conn.execute(
                text(
                    "SELECT criterion_id, verdict FROM engine.criterion_results WHERE run_id = :id"
                ),
                {"id": run_id},
            )
        ).all()
        have = {row.criterion_id for row in rows}
        missing = [c for c in request.criteria if c.criterion_id not in have]
        if missing and now < run.deadline_at:
            return  # an early finalize with checks still running; the deadline job comes later
        for criterion in missing:
            await _store_result(
                conn,
                run_id,
                criterion.criterion_id,
                "UNCERTAIN",
                "no verdict before the run deadline",
            )
        status = "TIMED_OUT" if missing else "COMPLETED"

        verdicts = {row.criterion_id: row.verdict for row in rows}
        required_failed = any(
            c.required and c.level != "AI_EVALUATED" and verdicts.get(c.criterion_id) == "FAIL"
            for c in request.criteria
        )
        # verification-adapters.md section 4: FAILED only when a required criterion FAILs, and not
        # for a model's FAIL: that is an opinion the buyer can overrule (ADR-0010).
        # Which criteria pay is Core's decision (H2 release math), from the per-criterion results.
        outcome = "FAILED" if required_failed else "PASSED"

        report = await _build_report(conn, run, request, status, outcome, now)
        report_hash = sha256(canonical(report))
        seq = (
            await conn.execute(
                text("""
                UPDATE engine.verification_runs
                SET status = :status, outcome = :outcome, finished_at = :now,
                    report = CAST(:report AS jsonb), report_hash = :hash, last_seq = last_seq + 1
                WHERE id = :id
                RETURNING last_seq
                """),
                {
                    "status": status,
                    "outcome": outcome,
                    "now": now,
                    "report": canonical(report).decode(),
                    "hash": report_hash,
                    "id": run_id,
                },
            )
        ).scalar_one()

        payload = {
            "runId": str(run_id),
            "submissionId": str(run.submission_id),
            "seq": seq,
            "status": status,
            "outcome": outcome,
            "results": [
                {
                    "criterionId": r["criterionId"],
                    "verdict": r["verdict"],
                    "evidenceRefCount": len(r["evidence"]),
                }
                for r in report["results"]
            ],
            "reportHash": report_hash,
        }
        await _emit(conn, run, "verification.run.completed", payload, actor=jobs.FINALIZE, now=now)


async def _build_report(
    conn: AsyncConnection,
    run: Row[Any],
    request: RunRequest,
    status: str,
    outcome: str,
    now: datetime,
) -> dict[str, Any]:
    results = (
        await conn.execute(
            text("""
            SELECT r.criterion_id, r.verdict, r.reason, r.source, r.injection_flags, r.checks,
                   coalesce(json_agg(json_build_object(
                     'snapshotId', s.id, 'kind', s.kind, 'hash', s.hash,
                     'sourceUrl', s.source_url, 'capturedAt', s.captured_at
                   ) ORDER BY s.captured_at, s.id) FILTER (WHERE s.id IS NOT NULL),
                   '[]') AS evidence
            FROM engine.criterion_results r
            LEFT JOIN engine.evidence_snapshots s ON s.id = ANY (r.evidence_refs)
            WHERE r.run_id = :id
            GROUP BY r.criterion_id, r.verdict, r.reason, r.source, r.injection_flags, r.checks
            """),
            {"id": run.id},
        )
    ).all()
    by_criterion = {row.criterion_id: row for row in results}
    # ADR-0008 decision 5: the Evidence Report is JSON, ordered like the contract's criteria.
    return {
        "runId": str(run.id),
        "milestoneId": str(run.milestone_id),
        "attempt": request.attempt,
        "status": status,
        "outcome": outcome,
        "startedAt": run.started_at.isoformat() if run.started_at else None,
        "finishedAt": now.isoformat(),
        "results": [
            {
                "criterionId": str(c.criterion_id),
                "verdict": by_criterion[c.criterion_id].verdict,
                "reason": by_criterion[c.criterion_id].reason,
                "source": by_criterion[c.criterion_id].source,
                "evidence": by_criterion[c.criterion_id].evidence,
                "injectionFlagged": len(by_criterion[c.criterion_id].injection_flags) > 0,
                "injectionFlags": by_criterion[c.criterion_id].injection_flags,
                # ADR-0019: the checks the verdict was computed from, for both parties to read.
                "checks": by_criterion[c.criterion_id].checks,
            }
            for c in request.criteria
        ],
    }


async def _emit(
    conn: AsyncConnection,
    run: Row[Any],
    event_type: str,
    payload: dict[str, Any],
    *,
    actor: str,
    now: datetime,
) -> None:
    event_id = (await conn.execute(text("SELECT uuidv7()"))).scalar_one()
    envelope = {
        "id": str(event_id),
        "type": event_type,
        "schemaVersion": 1,
        "occurredAt": now.isoformat(),
        "actor": {"type": "SYSTEM", "id": actor},
        "contractId": str(run.contract_id),
        "milestoneId": str(run.milestone_id),
        "correlationId": run.correlation_id,
        "causationId": None,
        "payload": payload,
    }
    await conn.execute(
        text("""
        INSERT INTO engine.outbox (id, run_id, type, envelope)
        VALUES (:id, :run_id, :type, CAST(:envelope AS jsonb))
        """),
        {"id": event_id, "run_id": run.id, "type": event_type, "envelope": json.dumps(envelope)},
    )
