"""The orchestrator driven by a real Procrastinate worker against Postgres."""

from collections.abc import AsyncIterator

import pytest
from procrastinate import App, PsycopgConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from support import FakeAdapter, adapters, all_rows, criterion, jobs_of, one, parse, run_request

from settld_engine import jobs, runs, tasks

pytestmark = pytest.mark.anyio


@pytest.fixture
async def worker_app(
    test_database_url: str, db: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[App]:
    monkeypatch.setattr(tasks, "_db", lambda: db)
    monkeypatch.setattr(tasks, "ADAPTERS", adapters(FakeAdapter()))
    conninfo = test_database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    app = tasks.create_app(PsycopgConnector(conninfo=conninfo))
    async with app.open_async():
        yield app


async def drain(app: App) -> None:
    # wait=False: the worker stops once nothing is due. The deadline finalize is scheduled
    # 5 minutes out, so it stays queued.
    await app.run_worker_async(queues=[jobs.QUEUE], wait=False, install_signal_handlers=False)


async def test_a_worker_takes_a_run_from_put_to_its_outbox_event(
    worker_app: App, db: AsyncEngine
) -> None:
    body = run_request(
        [criterion(), criterion(level="HUMAN", check_type=None), criterion(answer="FAIL")]
    )
    await runs.create_run(db, parse(body), correlation_id="req-1")

    await drain(worker_app)

    run = await one(db, "SELECT status, outcome FROM engine.verification_runs")
    assert (run.status, run.outcome) == ("COMPLETED", "FAILED")
    [event] = await all_rows(db, "SELECT type FROM engine.outbox")
    assert event.type == "verification.run.completed"


async def test_a_job_left_by_a_killed_worker_is_retried_and_the_run_completes(
    worker_app: App, db: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A starting worker defers the current minute's retry-stalled job, and whether it runs before
    # wait=False stops the worker is a race. When it won, the run below was already COMPLETED and
    # this test failed about 1 time in 20. This test calls the retry by hand, so the periodic one
    # goes away. delitem raises if the key is missing, so the schedule cannot vanish unnoticed.
    monkeypatch.delitem(
        worker_app.periodic_registry.periodic_tasks, (jobs.RETRY_STALLED, "retry-stalled")
    )

    await runs.create_run(db, parse(run_request([criterion()])), correlation_id="req-1")
    # kill -9: a worker took the start job and died without finishing it or saying goodbye.
    async with db.begin() as conn:
        dead = (await conn.execute(text("SELECT procrastinate_register_worker_v1()"))).scalar_one()
        await conn.execute(
            text("SELECT * FROM procrastinate_fetch_job_v2(ARRAY['verification'], :w)"), {"w": dead}
        )
        await conn.execute(
            text("UPDATE procrastinate_workers SET last_heartbeat = now() - interval '5 minutes'")
        )
    [start] = await jobs_of(db, jobs.START)
    assert start.status == "doing"

    # A new worker alone does not pick it up: it stays `doing` forever.
    await drain(worker_app)
    assert (await one(db, "SELECT status FROM engine.verification_runs")).status == "QUEUED"

    assert await tasks.retry_stalled_jobs(worker_app) == 1
    await drain(worker_app)

    assert (await one(db, "SELECT status FROM engine.verification_runs")).status == "COMPLETED"
    assert len(await all_rows(db, "SELECT id FROM engine.outbox")) == 1
