import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from settld_engine.main import app, get_db

# Port 1 refuses connections, so the check fails fast without a running database.
UNREACHABLE_URL = "postgresql+psycopg://engine_app:x@127.0.0.1:1/settld"


def client_with(db: AsyncEngine) -> Iterator[TestClient]:
    app.dependency_overrides[get_db] = lambda: db
    # Not used as a context manager, so the lifespan (and DATABASE_URL) is skipped.
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def unreachable_client() -> Iterator[TestClient]:
    yield from client_with(create_async_engine(UNREACHABLE_URL))


@pytest.fixture
def database_client() -> Iterator[TestClient]:
    url = os.environ.get("DATABASE_URL")
    if url is None:
        pytest.skip("DATABASE_URL not set; run `pnpm db:up` and `pnpm test:integration`")
    yield from client_with(create_async_engine(url))


def test_health_returns_503_when_database_unreachable(unreachable_client: TestClient) -> None:
    response = unreachable_client.get("/internal/v1/health")
    assert response.status_code == 503


def test_health_returns_200_when_database_reachable(database_client: TestClient) -> None:
    response = database_client.get("/internal/v1/health")
    assert response.status_code == 200
