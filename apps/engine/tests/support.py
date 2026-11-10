"""Builders and fakes shared by the database tests."""

import hashlib
import time
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from settld_engine import service_auth
from settld_engine.contracts import CheckType, RunRequest
from settld_engine.verification.adapters.base import (
    AdapterError,
    AdapterPolicy,
    CheckContext,
    CheckInput,
    CheckOutcome,
    Failed,
    Passed,
)

SNAPSHOT_HASH = "sha256:" + "a" * 64

# Test key pairs for the service tokens: Core signs with CORE_KEY, the Engine with ENGINE_KEY.
CORE_KEY = Ed25519PrivateKey.generate()
ENGINE_KEY = Ed25519PrivateKey.generate()
KEYS = service_auth.ServiceKeys(signing=ENGINE_KEY, peer=CORE_KEY.public_key())


def core_token(**overrides: Any) -> str:
    """A token as Core would sign it. An override of None drops that claim; _key signs with
    another key."""
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": "settld-core",
        "aud": "settld-engine",
        "iat": now,
        "exp": now + 60,
        "jti": str(uuid4()),
    }
    claims.update(overrides)
    key = claims.pop("_key", CORE_KEY)
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm="EdDSA")


async def _sign_as_core(request: httpx.Request) -> None:
    # A fresh token per request, like Core's client: the Engine refuses a jti it has seen.
    request.headers.setdefault("Authorization", f"Bearer {core_token()}")


def core_client(app: Any) -> httpx.AsyncClient:
    """An in-process client to the Engine that signs every request as Core."""
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://engine",
        event_hooks={"request": [_sign_as_core]},
    )


def criterion(
    *,
    level: str = "AUTOMATIC",
    check_type: str | None = "HTTP_PROBE",
    answer: str = "PASS",
    required: bool = True,
) -> dict[str, Any]:
    return {
        "criterionId": str(uuid4()),
        "text": f"criterion that will {answer}",
        "level": level,
        "required": required,
        "checkType": check_type,
        "checkConfig": {"answer": answer} if check_type else None,
    }


def run_request(
    criteria: list[dict[str, Any]] | None = None, deadline_in: timedelta = timedelta(minutes=5)
) -> dict[str, Any]:
    return {
        "runId": str(uuid4()),
        "submissionId": str(uuid4()),
        "milestoneId": str(uuid4()),
        "contractId": str(uuid4()),
        "lockedVersion": {"versionId": str(uuid4()), "snapshotHash": SNAPSHOT_HASH},
        "attempt": 1,
        "locale": "en",
        "deadlineAt": (datetime.now(UTC) + deadline_in).isoformat(),
        "criteria": criteria or [criterion()],
        "evidenceLinks": [{"kind": "URL", "url": "https://shop.example/"}],
    }


def parse(body: dict[str, Any]) -> RunRequest:
    return RunRequest.model_validate(body)


class FakeConfig(BaseModel):
    answer: Literal["PASS", "FAIL", "ERROR", "FATAL"]


class FakeAdapter:
    """Answers what the criterion's config says, snapshotting first like a real adapter."""

    check_types: frozenset[CheckType] = frozenset({"HTTP_PROBE"})
    config_model = FakeConfig
    policy = AdapterPolicy(timeout_seconds=5, max_attempts=2)

    def __init__(self) -> None:
        self.calls: list[UUID] = []

    async def execute(self, check: CheckInput[FakeConfig], ctx: CheckContext) -> CheckOutcome:
        self.calls.append(check.criterion_id)
        answer = check.config.answer
        if answer in ("ERROR", "FATAL"):
            return AdapterError(retryable=answer == "ERROR", reason="connection reset")
        ref = await ctx.snapshot(
            "HTTP_RESPONSE",
            f"evidence for {check.criterion_id}".encode(),
            content_type="text/plain",
        )
        if answer == "PASS":
            return Passed(reason="looks good", evidence_refs=[ref.id])
        return Failed(reason="does not match", evidence_refs=[ref.id])


def adapters(fake: FakeAdapter | None = None) -> dict[str, Any]:
    return {"HTTP_PROBE": fake or FakeAdapter()}


async def jobs_of(db: AsyncEngine, task: str | None = None) -> list[Any]:
    async with db.connect() as conn:
        rows = await conn.execute(
            text("""
            SELECT task_name, args, queueing_lock, scheduled_at, status
            FROM engine.procrastinate_jobs
            WHERE CAST(:task AS text) IS NULL OR task_name = :task
            ORDER BY id
            """),
            {"task": task},
        )
        return list(rows.all())


async def one(db: AsyncEngine, sql: str, **params: Any) -> Any:
    async with db.connect() as conn:
        return (await conn.execute(text(sql), params)).one()


async def all_rows(db: AsyncEngine, sql: str, **params: Any) -> list[Any]:
    async with db.connect() as conn:
        return list((await conn.execute(text(sql), params)).all())


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()
