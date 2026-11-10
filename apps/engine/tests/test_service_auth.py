"""Service tokens between Core and the Engine (service-boundaries.md section 3, ADR-0008 step 4)."""

import base64
import time
from collections.abc import AsyncIterator

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy.ext.asyncio import AsyncEngine
from support import CORE_KEY, ENGINE_KEY, KEYS, core_token, run_request

from settld_engine import service_auth
from settld_engine.main import app, get_db, get_keys

pytestmark = pytest.mark.anyio


@pytest.fixture
async def client(db: AsyncEngine) -> AsyncIterator[httpx.AsyncClient]:
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_keys] = lambda: KEYS
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://engine"
    ) as c:
        yield c
    app.dependency_overrides.clear()


async def put(client: httpx.AsyncClient, token: str | None) -> httpx.Response:
    body = run_request()
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    return await client.put(f"/internal/v1/runs/{body['runId']}", json=body, headers=headers)


async def test_a_token_signed_by_core_is_accepted(client: httpx.AsyncClient) -> None:
    assert (await put(client, core_token())).status_code == 202


@pytest.mark.parametrize(
    "token",
    [
        pytest.param(None, id="no token"),
        pytest.param("not-a-jwt", id="garbage"),
        pytest.param(
            core_token(iat=int(time.time()) - 120, exp=int(time.time()) - 60), id="expired"
        ),
        pytest.param(core_token(aud="settld-core"), id="meant for Core"),
        pytest.param(core_token(iss="settld-engine"), id="not issued by Core"),
        pytest.param(core_token(_key=Ed25519PrivateKey.generate()), id="someone else's key"),
        pytest.param(core_token(_key=ENGINE_KEY), id="the Engine's own key"),
        pytest.param(core_token(jti=None), id="no jti"),
        pytest.param(core_token(exp=int(time.time()) + 3600), id="lives longer than 60 s"),
    ],
)
async def test_a_bad_token_is_refused_and_nothing_is_stored(
    client: httpx.AsyncClient, db: AsyncEngine, token: str | None
) -> None:
    response = await put(client, token)

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHENTICATED"
    async with db.connect() as conn:
        count = await conn.exec_driver_sql("SELECT count(*) FROM engine.verification_runs")
        assert count.scalar_one() == 0


async def test_a_replayed_token_is_refused(client: httpx.AsyncClient) -> None:
    # Someone who captured a valid token (a log, a proxy) cannot use it again within its 60 s.
    token = core_token()
    assert (await put(client, token)).status_code == 202
    assert (await put(client, token)).status_code == 401


async def test_health_needs_no_token(client: httpx.AsyncClient) -> None:
    assert (await client.get("/internal/v1/health")).status_code == 200


def test_the_engine_signs_tokens_core_can_verify() -> None:
    token = service_auth.sign(KEYS)
    claims = jwt.decode(
        token,
        ENGINE_KEY.public_key(),
        algorithms=["EdDSA"],
        audience="settld-core",
        issuer="settld-engine",
    )
    assert claims["exp"] - claims["iat"] == 60
    assert claims["jti"]


def test_keys_load_from_base64_der() -> None:
    private = base64.b64encode(
        ENGINE_KEY.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    ).decode()
    public = base64.b64encode(
        CORE_KEY.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    ).decode()
    keys = service_auth.load_keys(
        {"ENGINE_SERVICE_PRIVATE_KEY": private, "CORE_SERVICE_PUBLIC_KEY": public}
    )
    assert keys is not None
    jwt.decode(
        service_auth.sign(keys),
        ENGINE_KEY.public_key(),
        algorithms=["EdDSA"],
        audience="settld-core",
    )
