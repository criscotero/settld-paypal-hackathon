import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

ENGINE_DIR = Path(__file__).parent.parent


@pytest.fixture
def anyio_backend() -> str:
    # The Engine runs on asyncio (uvicorn, Procrastinate); trio is never used.
    return "asyncio"


def _test_database_url() -> str | None:
    if url := os.environ.get("TEST_DATABASE_URL"):
        return url
    dev = os.environ.get("DATABASE_URL")
    if dev is None:
        return None
    # Same server, `settld_test` database, like Core's e2e tests: these tests truncate tables,
    # so they never point at the development database.
    return dev.rsplit("/", 1)[0] + "/settld_test"


@pytest.fixture(scope="session")
def test_database_url() -> str:
    url = _test_database_url()
    if url is None:
        pytest.skip("DATABASE_URL not set; run `pnpm db:up` and `pnpm test:integration`")
    config = Config(str(ENGINE_DIR / "alembic.ini"))
    config.attributes["url"] = url
    command.upgrade(config, "head")
    return url


@pytest.fixture
async def db(test_database_url: str) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(test_database_url)
    async with engine.begin() as conn:
        # TRUNCATE skips row triggers, so the append-only tables can be emptied between tests.
        await conn.execute(
            text("""
            TRUNCATE engine.service_token_jti, engine.outbox, engine.criterion_results,
                     engine.ai_verdict_records,
                     engine.evidence_snapshots, engine.verification_runs, engine.procrastinate_jobs,
                     engine.procrastinate_workers CASCADE
            """)
        )
    yield engine
    await engine.dispose()
