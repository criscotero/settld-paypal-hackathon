"""engine.outbox.dispatch: the Engine's outbox delivered to Core (ADR-0008 step 5, SB-6)."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import jwt
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from support import ENGINE_KEY, KEYS

from settld_engine import outbox

pytestmark = pytest.mark.anyio

CORE = "http://core.test"
NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)


async def pending_event(db: AsyncEngine, created_at: datetime = NOW) -> str:
    event_id = str(uuid4())
    envelope = {"id": event_id, "type": "verification.run.completed", "payload": {"n": 1}}
    async with db.begin() as conn:
        await conn.execute(
            text("""
            INSERT INTO engine.outbox (id, type, envelope, created_at, next_attempt_at)
            VALUES (:id, 'verification.run.completed', CAST(:env AS jsonb), :at, :at)
            """),
            {"id": event_id, "env": json.dumps(envelope), "at": created_at},
        )
    return event_id


async def row(db: AsyncEngine, event_id: str) -> Any:
    async with db.connect() as conn:
        return (
            await conn.execute(text("SELECT * FROM engine.outbox WHERE id = :id"), {"id": event_id})
        ).one()


class FakeCore:
    """Core's /internal/v1/events: answers with the scripted statuses, records what arrived."""

    def __init__(self, *statuses: int) -> None:
        self.statuses = list(statuses)
        self.received: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.received.append(request)
        status = self.statuses.pop(0) if self.statuses else 200
        if status == 0:
            raise httpx.ConnectError("connection refused")
        return httpx.Response(status, json={})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))


async def deliver(db: AsyncEngine, core: FakeCore, now: datetime = NOW) -> int:
    async with core.client() as client:
        return await outbox.deliver_pending(db, client, KEYS, CORE, now=now)


async def test_an_event_is_posted_signed_and_marked_delivered_once(db: AsyncEngine) -> None:
    event_id = await pending_event(db)
    core = FakeCore(200)

    assert await deliver(db, core) == 1
    assert await deliver(db, core) == 0

    [request] = core.received
    assert str(request.url) == f"{CORE}/internal/v1/events"
    assert json.loads(request.content)["id"] == event_id
    token = request.headers["Authorization"].removeprefix("Bearer ")
    claims = jwt.decode(
        token, ENGINE_KEY.public_key(), algorithms=["EdDSA"], audience="settld-core"
    )
    assert claims["iss"] == "settld-engine"
    assert (await row(db, event_id)).delivered_at == NOW


@pytest.mark.parametrize("status", [0, 500, 503, 401])
async def test_a_failed_delivery_backs_off_and_is_retried_later(
    db: AsyncEngine, status: int
) -> None:
    # Core down, or refusing a token it may accept once its keys are fixed: try again later.
    event_id = await pending_event(db)
    core = FakeCore(status, 200)

    assert await deliver(db, core) == 0
    after = await row(db, event_id)
    assert after.delivered_at is None
    assert after.attempts == 1
    assert after.next_attempt_at > NOW
    assert after.last_error

    assert await deliver(db, core, NOW + timedelta(milliseconds=500)) == 0
    assert len(core.received) == 1
    assert await deliver(db, core, after.next_attempt_at) == 1


async def test_the_backoff_is_capped_at_five_minutes(db: AsyncEngine) -> None:
    event_id = await pending_event(db)
    gaps = []
    now = NOW
    for _ in range(12):
        await deliver(db, FakeCore(503), now)
        nxt = (await row(db, event_id)).next_attempt_at
        gaps.append(nxt - now)
        now = nxt
    assert gaps[0] == timedelta(seconds=2)
    assert gaps == sorted(gaps)
    assert gaps[-1] == timedelta(minutes=5)


async def test_a_422_is_never_retried(db: AsyncEngine) -> None:
    # internal-api.yaml: an unknown type or a payload that fails its schema. Resending the same
    # bytes gets the same answer forever; a person has to look.
    event_id = await pending_event(db)
    core = FakeCore(422)

    await deliver(db, core)
    await deliver(db, core, NOW + timedelta(days=30))

    assert len(core.received) == 1
    parked = await row(db, event_id)
    assert parked.delivered_at is None
    assert parked.parked_at == NOW
    assert "422" in parked.last_error


async def test_events_go_out_in_the_order_they_were_written(db: AsyncEngine) -> None:
    second = await pending_event(db, NOW - timedelta(seconds=1))
    first = await pending_event(db, NOW - timedelta(seconds=2))
    core = FakeCore()

    assert await deliver(db, core) == 2

    assert [json.loads(r.content)["id"] for r in core.received] == [first, second]
