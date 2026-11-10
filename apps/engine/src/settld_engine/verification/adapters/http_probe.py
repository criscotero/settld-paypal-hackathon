# HTTP_PROBE: is the delivered URL live and showing what the contract promised?
# Semantics in verification-adapters.md section 3; decisions in ADR-0008.
#
# The adapter fetches, snapshots, then judges, in that order: the verdict is computed from the
# evidence that was stored (constitution VII), so what the parties see later is exactly what
# was judged.
import asyncio
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx

from settld_engine.contracts import CheckType, HttpProbeConfig
from settld_engine.verification.adapters.base import (
    AdapterError,
    AdapterPolicy,
    CheckContext,
    CheckInput,
    CheckOutcome,
    Failed,
    Passed,
    Uncertain,
)
from settld_engine.verification.ssrf import (
    BlockedTargetError,
    Resolver,
    pin_target,
    resolve_host,
)

MAX_REDIRECTS = 3
# Enough for any landing page; past it the body is not read. Bounds memory, including for a
# gzip bomb, since the cap applies to decoded bytes.
MAX_BODY_BYTES = 2 * 1024 * 1024
PREVIEW_BYTES = 64 * 1024  # contract: "first 64 KB" in the evidence
KEPT_HEADERS = (
    "content-type",
    "content-length",
    "server",
    "date",
    "last-modified",
    "etag",
    "cache-control",
)
USER_AGENT = "SettldVerifier/1 (+https://settld.app/verifier)"


@dataclass
class ProbeResult:
    requested_url: str
    method: str
    redirects: list[dict[str, Any]] = field(default_factory=list)
    final_url: str = ""
    ip: str = ""
    status: int = 0
    headers: dict[str, str] = field(default_factory=dict)
    elapsed_ms: int = 0
    body: bytes = b""
    body_truncated: bool = False
    text: str = ""

    def evidence(self) -> bytes:
        # Sorted keys and fixed separators: the same response always gives the same bytes,
        # so the same snapshot hash.
        return json.dumps(
            {
                "requestedUrl": self.requested_url,
                "method": self.method,
                "redirects": self.redirects,
                "finalUrl": self.final_url,
                "ip": self.ip,
                "status": self.status,
                "headers": self.headers,
                "elapsedMs": self.elapsed_ms,
                "bodyBytes": len(self.body),
                "bodyTruncated": self.body_truncated,
                "bodySha256": "sha256:" + hashlib.sha256(self.body).hexdigest(),
                "bodyPreview": self.text[:PREVIEW_BYTES],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()


class HttpProbeAdapter:
    check_types: frozenset[CheckType] = frozenset({"HTTP_PROBE"})
    config_model = HttpProbeConfig
    # Two attempts: one retry absorbs a dropped connection; more would not fit the 45 s budget
    # inside the 5-minute run deadline alongside the other checks.
    policy = AdapterPolicy(timeout_seconds=45, max_attempts=2)

    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        resolver: Resolver = resolve_host,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._transport = transport
        self._resolver = resolver
        self._clock = clock

    async def execute(self, check: CheckInput[HttpProbeConfig], ctx: CheckContext) -> CheckOutcome:
        config = check.config
        budget = min(
            self.policy.timeout_seconds, (ctx.deadline - datetime.now(UTC)).total_seconds()
        )
        if budget <= 0:
            return Uncertain(
                reason="the run deadline passed before the probe started", evidence_refs=[]
            )

        try:
            async with asyncio.timeout(budget):
                result = await self.probe(config)
        except TimeoutError:
            # UNCERTAIN, not FAIL: a slow server is not proof the work is missing, and only
            # PASS ever counts toward a release (constitution VI).
            ref = await note_unreachable(ctx, config.url, f"timed out after {budget:.0f} s")
            return Uncertain(reason=f"timed out after {budget:.0f} s", evidence_refs=[ref])
        except BlockedTargetError as blocked:
            ref = await note_unreachable(ctx, config.url, str(blocked))
            return Failed(reason=str(blocked), evidence_refs=[ref])
        except (httpx.TransportError, OSError) as error:
            # DNS failures and refused or reset connections may be transient; the orchestrator
            # retries, and stores UNCERTAIN once attempts run out.
            return AdapterError(retryable=True, reason=f"{type(error).__name__}: {error}")

        snapshot = await ctx.snapshot(
            "HTTP_RESPONSE",
            result.evidence(),
            content_type="application/json",
            source_url=config.url,
        )
        return _judge(config, result, [snapshot.id])

    async def probe(self, config: HttpProbeConfig) -> ProbeResult:
        result = ProbeResult(requested_url=config.url, method=config.method)
        url = httpx.URL(config.url)
        # Redirects are followed by hand so every hop goes through pin_target. httpx's own
        # follow_redirects would connect to the next host by name, unchecked.
        # trust_env=False: an HTTPS_PROXY in the environment would make httpx connect to the
        # proxy, and the proxy to whatever IP it likes, bypassing the check entirely.
        async with httpx.AsyncClient(
            transport=self._transport or httpx.AsyncHTTPTransport(trust_env=False),
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(10.0, connect=5.0),
        ) as client:
            started = self._clock()
            for _ in range(MAX_REDIRECTS + 1):
                target = await pin_target(url, self._resolver)
                request = client.build_request(
                    config.method,
                    target.url,
                    headers={"Host": target.host_header, "User-Agent": USER_AGENT},
                    extensions={"sni_hostname": target.sni_hostname},
                )
                response = await client.send(request, stream=True)
                try:
                    location = response.headers.get("location")
                    if response.is_redirect and location is not None:
                        result.redirects.append(
                            {
                                "url": str(url),
                                "ip": target.ip,
                                "status": response.status_code,
                                "location": location,
                            }
                        )
                        # Joined against the hostname URL, not target.url, so the next hop
                        # is resolved and checked again instead of reusing this IP.
                        url = url.join(location)
                        continue
                    result.body, result.body_truncated = await _read_capped(response)
                    result.elapsed_ms = round((self._clock() - started) * 1000)
                    result.final_url = str(url)
                    result.ip = target.ip
                    result.status = response.status_code
                    result.headers = {
                        name: response.headers[name]
                        for name in KEPT_HEADERS
                        if name in response.headers
                    }
                    result.text = _decode(result.body, response.charset_encoding)
                    return result
                finally:
                    await response.aclose()
        raise BlockedTargetError(f"more than {MAX_REDIRECTS} redirects")


async def _read_capped(response: httpx.Response) -> tuple[bytes, bool]:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            return b"".join(chunks)[:MAX_BODY_BYTES], True
    return b"".join(chunks), False


def _decode(body: bytes, charset: str | None) -> str:
    try:
        return body.decode(charset or "utf-8", errors="replace")
    except LookupError:  # a charset Python does not know
        return body.decode("utf-8", errors="replace")


async def note_unreachable(ctx: CheckContext, url: str, message: str) -> UUID:
    # No response to snapshot, but the verdict still points at evidence from this run.
    data = json.dumps({"requestedUrl": url, "note": message}, sort_keys=True).encode()
    ref = await ctx.snapshot("NOTES", data, content_type="application/json", source_url=url)
    return ref.id


def _judge(config: HttpProbeConfig, result: ProbeResult, refs: list[UUID]) -> CheckOutcome:
    failures: list[str] = []
    unknowns: list[str] = []
    if result.status != config.expect_status:
        failures.append(f"expected status {config.expect_status}, got {result.status}")
    for text in config.expect_body_contains:
        if text in result.text:
            continue
        if result.body_truncated:
            unknowns.append(f"{text!r} not in the first {MAX_BODY_BYTES} bytes")
        else:
            failures.append(f"{text!r} not found")
    for text in config.expect_body_not_contains:
        if text in result.text:
            failures.append(f"{text!r} found")
        elif result.body_truncated:
            unknowns.append(f"{text!r} might appear after the first {MAX_BODY_BYTES} bytes")
    if config.max_response_ms is not None and result.elapsed_ms > config.max_response_ms:
        failures.append(f"took {result.elapsed_ms} ms, limit {config.max_response_ms} ms")

    # A definite failure wins over an unknown: one broken expectation is already enough.
    if failures:
        return Failed(reason="; ".join(failures), evidence_refs=refs)
    if unknowns:
        return Uncertain(reason="; ".join(unknowns), evidence_refs=refs)
    return Passed(
        reason=f"{config.method} {result.final_url} returned {result.status}", evidence_refs=refs
    )
