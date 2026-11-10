import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncEngine
from support import (
    KEYS,
    adapters,
    all_rows,
    core_client,
    criterion,
    jobs_of,
    parse,
    run_request,
)

from settld_engine import jobs, orchestrator, runs
from settld_engine.main import app, get_db, get_keys

pytestmark = pytest.mark.anyio


@pytest.fixture
async def client(db: AsyncEngine) -> AsyncIterator[httpx.AsyncClient]:
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_keys] = lambda: KEYS
    # ASGITransport runs the app on this test's event loop, so the AsyncEngine and its pool are
    # used from the loop that created them.
    async with core_client(app) as c:
        yield c
    app.dependency_overrides.clear()


async def put(client: httpx.AsyncClient, body: dict[str, Any], **headers: str) -> httpx.Response:
    return await client.put(f"/internal/v1/runs/{body['runId']}", json=body, headers=headers)


async def test_a_new_run_is_queued_with_its_start_job(
    client: httpx.AsyncClient, db: AsyncEngine
) -> None:
    body = run_request()

    response = await put(client, body, **{"X-Request-Id": "req-123"})

    assert response.status_code == 202
    assert response.json() == {"runId": body["runId"], "status": "QUEUED", "outcome": None}
    [job] = await jobs_of(db)
    assert job.task_name == jobs.START
    assert job.args == {"runId": body["runId"]}
    assert job.queueing_lock == f"run:{body['runId']}"
    [run] = await all_rows(db, "SELECT correlation_id, request FROM engine.verification_runs")
    assert run.correlation_id == "req-123"
    assert run.request["criteria"][0]["criterionId"] == body["criteria"][0]["criterionId"]


async def test_the_same_body_again_returns_200_and_enqueues_nothing(
    client: httpx.AsyncClient, db: AsyncEngine
) -> None:
    body = run_request()
    await put(client, body)

    # Core's dispatch job retries with the same runId after a lost answer.
    again = await put(client, body)
    reordered = await client.put(
        f"/internal/v1/runs/{body['runId']}",
        content=json.dumps(dict(reversed(list(body.items())))),
        headers={"content-type": "application/json"},
    )

    assert again.status_code == 200
    assert reordered.status_code == 200
    assert len(await jobs_of(db)) == 1


async def test_a_different_body_for_the_same_run_is_409(
    client: httpx.AsyncClient, db: AsyncEngine
) -> None:
    body = run_request()
    await put(client, body)

    response = await put(client, body | {"attempt": 2})

    assert response.status_code == 409
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert len(await jobs_of(db)) == 1


async def test_a_second_run_for_the_same_submission_is_409(client: httpx.AsyncClient) -> None:
    body = run_request()
    await put(client, body)

    other = run_request() | {"submissionId": body["submissionId"]}
    response = await put(client, other)

    assert response.status_code == 409
    assert response.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_ten_concurrent_puts_create_one_run_and_one_job(
    client: httpx.AsyncClient, db: AsyncEngine
) -> None:
    body = run_request()

    responses = await asyncio.gather(*(put(client, body) for _ in range(10)))

    assert sorted(r.status_code for r in responses) == [200] * 9 + [202]
    assert len(await jobs_of(db)) == 1


async def test_run_and_job_commit_together(
    db: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Constitution IV: if the job cannot be written, the run must not exist either. Otherwise
    # Core's retry gets 200 for a run nobody will ever start.
    async def broken_defer(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("database gone between the two inserts")

    monkeypatch.setattr(jobs, "defer", broken_defer)
    body = parse(run_request())

    with pytest.raises(RuntimeError):
        await runs.create_run(db, body, correlation_id="c")

    assert await all_rows(db, "SELECT id FROM engine.verification_runs") == []


async def test_invalid_bodies_are_422_problems(client: httpx.AsyncClient) -> None:
    body = run_request()

    wrong_path = await client.put(f"/internal/v1/runs/{run_request()['runId']}", json=body)
    no_criteria = await put(client, body | {"criteria": []})
    naive_deadline = await put(client, body | {"deadlineAt": "2026-10-22T10:00:00"})
    unknown_field = await put(client, body | {"priority": "high"})

    for response in (wrong_path, no_criteria, naive_deadline, unknown_field):
        assert response.status_code == 422
        assert response.json()["code"] == "VALIDATION_FAILED"


async def test_get_run_returns_the_evidence_report(
    client: httpx.AsyncClient, db: AsyncEngine
) -> None:
    # internal-api.yaml getRun: the Evidence Report. Core's watchdog reads the verdicts from it
    # when the completion event was lost, so a finished run carries every result and its hash.
    body = run_request([criterion(level="HUMAN", check_type=None)])
    await put(client, body)

    queued = (await client.get(f"/internal/v1/runs/{body['runId']}")).json()
    assert queued == {
        "runId": body["runId"],
        "milestoneId": body["milestoneId"],
        "attempt": 1,
        "status": "QUEUED",
        "outcome": None,
        "startedAt": None,
        "finishedAt": None,
        "results": [],
        "reportHash": None,
    }

    # Only a HUMAN criterion: nothing to check, so start and finalize finish the run.
    await orchestrator.start_run(db, adapters(), UUID(body["runId"]))
    await orchestrator.finalize_run(db, UUID(body["runId"]))
    done = (await client.get(f"/internal/v1/runs/{body['runId']}")).json()
    assert done["status"] == "COMPLETED"
    assert done["reportHash"].startswith("sha256:")
    assert done["results"] == [
        {
            "criterionId": body["criteria"][0]["criterionId"],
            "verdict": "NEEDS_HUMAN",
            "reason": done["results"][0]["reason"],
            "source": "ADAPTER",
            "evidence": [],
            "injectionFlagged": False,
            "injectionFlags": [],
            "checks": [],
        }
    ]

    missing = await client.get(f"/internal/v1/runs/{run_request()['runId']}")
    assert missing.status_code == 404
