# engine.outbox.dispatch (events.md 3.2, ADR-0008 step 5): delivers the Engine's outbox to Core
# API's POST /internal/v1/events until Core acknowledges.
#
# The other half of SB-6. finalize wrote the event in the same transaction as the verdicts, so
# the fact cannot be lost; this loop makes sure it also arrives. It is at-least-once on purpose:
# a kill -9 after Core's 200 and before our UPDATE sends the event again, and Core's inbox
# dedups it by event id. Exactly-once delivery over a network does not exist; exactly-once
# processing does, and it lives on the receiving side.
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from settld_engine import service_auth

log = logging.getLogger(__name__)

BATCH = 50
TIMEOUT_SECONDS = 10.0
FIRST_BACKOFF = timedelta(seconds=2)
MAX_BACKOFF = timedelta(minutes=5)  # events.md: backoff capped at 5 minutes
ALERT_AFTER = timedelta(hours=1)  # events.md: alert after 1 hour undelivered


async def deliver_pending(
    db: AsyncEngine,
    client: httpx.AsyncClient,
    keys: service_auth.ServiceKeys,
    core_url: str,
    *,
    now: datetime | None = None,
) -> int:
    """Sends every due event, oldest first. Returns how many Core acknowledged."""
    now = now or datetime.now(UTC)
    delivered = 0
    for _ in range(BATCH):
        async with db.begin() as conn:
            # SKIP LOCKED: two dispatchers (a second worker, an overlap of the 5 s schedule) each
            # take different rows instead of sending the same event twice at the same moment.
            # The lock is held across the HTTP call; it covers one outbox row, not the run, so
            # nothing that verifies has to wait for it.
            row = (
                await conn.execute(
                    text("""
                    SELECT id, envelope, attempts, created_at FROM engine.outbox
                    WHERE delivered_at IS NULL AND parked_at IS NULL AND next_attempt_at <= :now
                    ORDER BY created_at, id
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                    """),
                    {"now": now},
                )
            ).first()
            if row is None:
                break
            outcome = await _post(client, keys, core_url, row.envelope)
            if outcome is None:
                await conn.execute(
                    text("UPDATE engine.outbox SET delivered_at = :now WHERE id = :id"),
                    {"now": now, "id": row.id},
                )
                delivered += 1
                continue
            error, retry = outcome
            if retry:
                if now - row.created_at > ALERT_AFTER:
                    log.error("outbox event %s undelivered for over an hour: %s", row.id, error)
                # Exponential: 2 s, 4 s, 8 s ... capped at 5 minutes, so a Core that is down for
                # an hour is asked about a dozen times an hour, not every 5 seconds.
                await conn.execute(
                    text("""
                    UPDATE engine.outbox
                    SET attempts = attempts + 1, last_error = :error, next_attempt_at = :next
                    WHERE id = :id
                    """),
                    {
                        "error": error,
                        "id": row.id,
                        "next": now + min(FIRST_BACKOFF * 2**row.attempts, MAX_BACKOFF),
                    },
                )
            else:
                # Core said 422: the same bytes will never be accepted. Parked for a person
                # instead of retried forever.
                log.error("outbox event %s refused by Core, parked: %s", row.id, error)
                await conn.execute(
                    text("""
                    UPDATE engine.outbox
                    SET attempts = attempts + 1, last_error = :error, parked_at = :now
                    WHERE id = :id
                    """),
                    {"error": error, "id": row.id, "now": now},
                )
            if retry:
                # Core is failing; the rest of the batch would most likely fail the same way.
                break
    return delivered


async def _post(
    client: httpx.AsyncClient,
    keys: service_auth.ServiceKeys,
    core_url: str,
    envelope: dict[str, Any],
) -> tuple[str, bool] | None:
    """None when Core acknowledged; otherwise (error, whether to retry)."""
    try:
        response = await client.post(
            f"{core_url}/internal/v1/events",
            json=envelope,
            # A fresh token per call: Core refuses a jti it has already seen.
            headers={"Authorization": f"Bearer {service_auth.sign(keys)}"},
            timeout=TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as error:
        return f"{type(error).__name__}: {error}", True
    if response.status_code == 200:
        return None
    # 422 is the contract's "never". Everything else may pass later: a 5xx, a 401 while keys
    # are being rotated, a 404 while Core is deploying.
    return f"{response.status_code} {response.text[:500]}", response.status_code != 422
