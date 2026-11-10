# Procrastinate tasks: thin wrappers that call the orchestrator. Run the worker with
#   procrastinate --app=settld_engine.tasks.app worker --queues=verification --concurrency=8
# Concurrency because an AI check can take minutes: with the default of 1 it would hold back
# every other job on the queue, including the outbox dispatch that delivers results to Core.
#
# Task names and payload keys come from events.md section 3.2. Procrastinate passes the payload
# as keyword arguments, which is why the parameters are camelCase.
import logging
import os
from functools import cache
from uuid import UUID

import httpx
from procrastinate import App, JobContext, PsycopgConnector, RetryStrategy
from procrastinate.connector import BaseConnector
from sqlalchemy.ext.asyncio import AsyncEngine

from settld_engine import jobs, orchestrator, outbox, service_auth
from settld_engine.db import create_engine_from_env
from settld_engine.verification.adapters.ai_check import ai_adapters
from settld_engine.verification.adapters.http_probe import HttpProbeAdapter

ADAPTERS: orchestrator.Adapters = {"HTTP_PROBE": HttpProbeAdapter(), **ai_adapters(os.environ)}


log = logging.getLogger(__name__)


@cache
def _db() -> AsyncEngine:
    return create_engine_from_env()


@cache
def _keys() -> service_auth.ServiceKeys | None:
    return service_auth.load_keys(os.environ)


def _core_url() -> str:
    return os.environ.get("CORE_API_URL", "http://localhost:4000").rstrip("/")


def create_app(connector: BaseConnector) -> App:
    # A factory, not module-level decorators: a test builds a fresh app on the test database.
    # Procrastinate's app keeps its pool after closing, so one shared app cannot be reopened.
    app = App(connector=connector)

    @app.task(
        name=jobs.START, queue=jobs.QUEUE, retry=RetryStrategy(max_attempts=3, exponential_wait=2)
    )
    async def start(runId: str) -> None:
        await orchestrator.start_run(_db(), ADAPTERS, UUID(runId))

    # Procrastinate's retry limit covers crashes (a bug, the database gone). How often a flaky
    # URL is retried is the adapter's policy, applied inside check_criterion with the attempt
    # count.
    @app.task(
        name=jobs.CHECK,
        queue=jobs.QUEUE,
        pass_context=True,
        retry=RetryStrategy(max_attempts=4, wait=2, exponential_wait=2),
    )
    async def check(context: JobContext, runId: str, criterionId: str) -> None:
        attempts = context.job.attempts if context.job else 0
        await orchestrator.check_criterion(
            _db(), ADAPTERS, UUID(runId), UUID(criterionId), attempts
        )

    @app.task(
        name=jobs.FINALIZE,
        queue=jobs.QUEUE,
        retry=RetryStrategy(max_attempts=3, exponential_wait=2),
    )
    async def finalize(runId: str) -> None:
        await orchestrator.finalize_run(_db(), UUID(runId))

    @app.periodic(cron="* * * * *", periodic_id="retry-stalled")
    @app.task(
        name=jobs.RETRY_STALLED, queue=jobs.QUEUE, queueing_lock="retry_stalled", pass_context=True
    )
    async def retry_stalled(context: JobContext, timestamp: int) -> None:
        await retry_stalled_jobs(context.app)

    # events.md 3.2: every 5 seconds (croniter's sixth field is seconds). The queueing lock keeps
    # at most one waiting, so a slow delivery never piles up dispatchers behind it.
    @app.periodic(cron="* * * * * */5", periodic_id="outbox-dispatch")
    @app.task(name=jobs.OUTBOX_DISPATCH, queue=jobs.QUEUE, queueing_lock="outbox_dispatch")
    async def outbox_dispatch(timestamp: int) -> None:
        keys = _keys()
        if keys is None:
            # Unsigned events would be refused by Core anyway; they wait in the outbox instead.
            log.error("outbox not delivered: ENGINE_SERVICE_PRIVATE_KEY / CORE_SERVICE_PUBLIC_KEY")
            return
        async with httpx.AsyncClient() as client:
            await outbox.deliver_pending(_db(), client, keys, _core_url())

    return app


async def retry_stalled_jobs(procrastinate_app: App) -> int:
    # A worker killed with -9 leaves its jobs in `doing` forever: the next worker prunes the dead
    # worker's row but does not touch its jobs. "Stalled" means the owning worker has not sent a
    # heartbeat for 30 s (or is gone), so a slow but alive check is never run twice.
    manager = procrastinate_app.job_manager
    stalled = list(await manager.get_stalled_jobs())
    for job in stalled:
        await manager.retry_job(job)
    return len(stalled)


# Same database and role as SQLAlchemy (engine_app), without the SQLAlchemy driver suffix. The
# pool only connects when the worker opens the app, so importing this module without
# DATABASE_URL (unit tests, mypy) works.
app = create_app(
    PsycopgConnector(
        conninfo=os.environ.get("DATABASE_URL", "").replace(
            "postgresql+psycopg://", "postgresql://", 1
        )
    )
)
