import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from settld_engine.contracts import HttpProbeConfig
from settld_engine.verification.adapters.base import (
    AdapterError,
    CheckInput,
    EvidenceKind,
    Failed,
    Passed,
    SnapshotRef,
    Uncertain,
)
from settld_engine.verification.adapters.http_probe import MAX_BODY_BYTES, HttpProbeAdapter

pytestmark = pytest.mark.anyio

PUBLIC_IP = "93.184.215.14"
Handler = Callable[[httpx.Request], Awaitable[httpx.Response]]


class FakeContext:
    def __init__(self, deadline_in: timedelta = timedelta(minutes=5)) -> None:
        self.snapshots: list[dict[str, Any]] = []
        self._deadline = datetime.now(UTC) + deadline_in

    async def snapshot(
        self, kind: EvidenceKind, data: bytes, *, content_type: str, source_url: str | None = None
    ) -> SnapshotRef:
        ref = SnapshotRef(id=uuid4(), hash="sha256:" + hashlib.sha256(data).hexdigest())
        self.snapshots.append(
            {"id": ref.id, "kind": kind, "data": json.loads(data), "source_url": source_url}
        )
        return ref

    def record_ai(self, call: Any) -> None:
        raise NotImplementedError

    async def github_token(self, repository: str) -> str:
        raise NotImplementedError

    @property
    def deadline(self) -> datetime:
        return self._deadline


def resolver_for(table: dict[str, list[str]]) -> Callable[[str, int], Awaitable[list[str]]]:
    async def resolve(host: str, port: int) -> list[str]:
        return table[host]

    return resolve


def check(**config: Any) -> CheckInput[HttpProbeConfig]:
    base: dict[str, Any] = {"url": "https://shop.example/", "method": "GET", "expectStatus": 200}
    return CheckInput[HttpProbeConfig](
        run_id=uuid4(),
        criterion_id=uuid4(),
        criterion_text="The landing page is live",
        check_type="HTTP_PROBE",
        config=HttpProbeConfig.model_validate(base | config),
        evidence_links=[],
    )


class Recorder:
    """A MockTransport whose handler is async and whose requests are kept for assertions."""

    def __init__(self, handler: Handler) -> None:
        self.requests: list[httpx.Request] = []

        async def record(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            return await handler(request)

        self.transport = httpx.MockTransport(record)


def respond(status: int = 200, body: bytes = b"", **headers: str) -> Handler:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers=headers)

    return handler


def adapter(
    handler: Handler,
    dns: dict[str, list[str]] | None = None,
    clock: Callable[[], float] | None = None,
) -> tuple[HttpProbeAdapter, Recorder]:
    recorder = Recorder(handler)
    kwargs: dict[str, Any] = {}
    if clock is not None:
        kwargs["clock"] = clock
    probe = HttpProbeAdapter(
        transport=recorder.transport,
        resolver=resolver_for(dns or {"shop.example": [PUBLIC_IP]}),
        **kwargs,
    )
    return probe, recorder


# --- verdicts -----------------------------------------------------------------------------


async def test_passes_when_status_and_body_match_and_snapshots_before_judging() -> None:
    body = b"<h1>Welcome to the shop</h1>"
    probe, _recorder = adapter(respond(200, body, **{"content-type": "text/html"}))
    ctx = FakeContext()

    outcome = await probe.execute(
        check(expectBodyContains=["Welcome"], expectBodyNotContains=["Under construction"]), ctx
    )

    assert isinstance(outcome, Passed)
    [snap] = ctx.snapshots
    assert outcome.evidence_refs == [snap["id"]]
    assert snap["kind"] == "HTTP_RESPONSE"
    assert snap["source_url"] == "https://shop.example/"
    evidence = snap["data"]
    assert evidence["status"] == 200
    assert evidence["ip"] == PUBLIC_IP
    assert evidence["bodySha256"] == "sha256:" + hashlib.sha256(body).hexdigest()
    assert evidence["bodyPreview"] == body.decode()
    assert evidence["headers"]["content-type"] == "text/html"


async def test_the_request_goes_to_the_checked_ip_with_the_original_host_and_sni() -> None:
    # Connecting to the IP that passed the check, not to the hostname, is what defeats DNS
    # rebinding: a second lookup could return 127.0.0.1.
    probe, recorder = adapter(respond(200))

    await probe.execute(check(), FakeContext())

    [request] = recorder.requests
    assert request.url.host == PUBLIC_IP
    assert request.headers["host"] == "shop.example"
    assert request.extensions["sni_hostname"] == "shop.example"


async def test_fails_on_an_unexpected_status() -> None:
    probe, _ = adapter(respond(404))
    ctx = FakeContext()

    outcome = await probe.execute(check(), ctx)

    assert isinstance(outcome, Failed)
    assert "expected status 200, got 404" in outcome.reason
    assert outcome.evidence_refs == [ctx.snapshots[0]["id"]]


async def test_fails_when_a_required_text_is_missing_or_a_forbidden_one_is_present() -> None:
    probe, _ = adapter(respond(200, b"Lorem ipsum. Under construction."))

    outcome = await probe.execute(
        check(expectBodyContains=["Checkout"], expectBodyNotContains=["Under construction"]),
        FakeContext(),
    )

    assert isinstance(outcome, Failed)
    # Every broken expectation is reported, so the seller fixes all of them in one round.
    assert "'Checkout' not found" in outcome.reason
    assert "'Under construction' found" in outcome.reason


async def test_fails_when_slower_than_max_response_ms() -> None:
    ticks = iter([10.0, 10.9])
    probe, _ = adapter(respond(200), clock=lambda: next(ticks))

    outcome = await probe.execute(check(maxResponseMs=500), FakeContext())

    assert isinstance(outcome, Failed)
    assert "900 ms" in outcome.reason


async def test_a_body_over_the_limit_without_the_text_is_uncertain_not_fail() -> None:
    # Past the limit the text might still be there; FAIL would be a guess (constitution VI).
    probe, _ = adapter(respond(200, b"x" * (MAX_BODY_BYTES + 10) + b"Checkout"))
    ctx = FakeContext()

    outcome = await probe.execute(check(expectBodyContains=["Checkout"]), ctx)

    assert isinstance(outcome, Uncertain)
    assert ctx.snapshots[0]["data"]["bodyTruncated"] is True


async def test_timeout_is_uncertain_with_a_note_as_evidence() -> None:
    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(10)
        raise AssertionError("unreachable")

    probe, _ = adapter(hang)
    ctx = FakeContext(deadline_in=timedelta(milliseconds=200))

    outcome = await probe.execute(check(), ctx)

    assert isinstance(outcome, Uncertain)
    assert "timed out" in outcome.reason
    assert ctx.snapshots[0]["kind"] == "NOTES"
    assert outcome.evidence_refs == [ctx.snapshots[0]["id"]]


async def test_a_deadline_already_past_is_uncertain_without_any_request() -> None:
    probe, recorder = adapter(respond(200))

    outcome = await probe.execute(check(), FakeContext(deadline_in=timedelta(seconds=-1)))

    assert isinstance(outcome, Uncertain)
    assert recorder.requests == []


async def test_a_network_error_is_a_retryable_adapter_error() -> None:
    async def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    probe, _ = adapter(refuse)

    outcome = await probe.execute(check(), FakeContext())

    assert isinstance(outcome, AdapterError)
    assert outcome.retryable


# --- SSRF -----------------------------------------------------------------------------------


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1"])
async def test_a_host_resolving_to_a_private_ip_fails_without_connecting(ip: str) -> None:
    probe, recorder = adapter(respond(200), dns={"shop.example": [ip]})
    ctx = FakeContext()

    outcome = await probe.execute(check(), ctx)

    assert isinstance(outcome, Failed)
    assert ip in outcome.reason
    assert recorder.requests == []
    assert ctx.snapshots[0]["kind"] == "NOTES"


async def test_a_redirect_to_a_private_ip_is_blocked_at_the_second_hop() -> None:
    probe, recorder = adapter(
        respond(302, location="https://internal.example/admin"),
        dns={"shop.example": [PUBLIC_IP], "internal.example": ["10.0.0.5"]},
    )

    outcome = await probe.execute(check(), FakeContext())

    assert isinstance(outcome, Failed)
    assert "10.0.0.5" in outcome.reason
    assert len(recorder.requests) == 1


async def test_a_redirect_to_plain_http_is_blocked() -> None:
    probe, recorder = adapter(respond(301, location="http://shop.example/"))

    outcome = await probe.execute(check(), FakeContext())

    assert isinstance(outcome, Failed)
    assert "https" in outcome.reason
    assert len(recorder.requests) == 1


def redirect_chain(length: int) -> Handler:
    async def handler(request: httpx.Request) -> httpx.Response:
        hop = int(request.url.params.get("hop", "0"))
        if hop < length:
            return httpx.Response(302, headers={"location": f"/next?hop={hop + 1}"})
        return httpx.Response(200)

    return handler


async def test_three_redirects_are_followed() -> None:
    probe, recorder = adapter(redirect_chain(3))
    ctx = FakeContext()

    outcome = await probe.execute(check(), ctx)

    assert isinstance(outcome, Passed)
    assert len(recorder.requests) == 4
    assert [h["status"] for h in ctx.snapshots[0]["data"]["redirects"]] == [302, 302, 302]


async def test_a_fourth_redirect_fails() -> None:
    probe, recorder = adapter(redirect_chain(4))

    outcome = await probe.execute(check(), FakeContext())

    assert isinstance(outcome, Failed)
    assert "more than 3 redirects" in outcome.reason
    assert len(recorder.requests) == 4


async def test_a_relative_redirect_resolves_against_the_hostname_not_the_ip() -> None:
    probe, recorder = adapter(redirect_chain(1))

    await probe.execute(check(), FakeContext())

    assert recorder.requests[1].headers["host"] == "shop.example"
    assert recorder.requests[1].url.path == "/next"


async def test_the_real_transport_never_connects_to_localhost() -> None:
    # No fakes: the system resolver and httpx's own transport. localhost resolves to a
    # loopback address, so the probe must fail before opening a socket.
    ctx = FakeContext()

    outcome = await HttpProbeAdapter().execute(check(url="https://localhost:9/"), ctx)

    assert isinstance(outcome, Failed)
    assert "not a public address" in outcome.reason


# --- config ---------------------------------------------------------------------------------


def test_the_config_rejects_plain_http_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        HttpProbeConfig.model_validate(
            {"url": "http://a.example", "method": "GET", "expectStatus": 200}
        )
    with pytest.raises(ValidationError):
        HttpProbeConfig.model_validate(
            {"url": "https://a.example", "method": "GET", "expectStatus": 200, "expectBody": "x"}
        )
