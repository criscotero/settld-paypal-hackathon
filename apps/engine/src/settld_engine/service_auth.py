# Service tokens between Core API and the Engine (service-boundaries.md section 3, SB-7,
# ADR-0008 decision 2): a JWT signed with Ed25519 that lives 60 seconds.
#
# Why asymmetric keys and not a shared HMAC secret: each service holds only its own private key
# and the other's public key. Whoever steals the Engine's secrets can sign as the Engine, never
# as Core; with one shared secret they could forge either side's calls.
#
# Why the jti table: a valid token stays valid for 60 s. Someone who reads one from a log or a
# proxy could replay the same request in that window. Recording each jti and refusing a second
# use closes it, and doing it in Postgres makes it hold across Engine instances.
import base64
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

ENGINE = "settld-engine"
CORE = "settld-core"
LIFETIME_SECONDS = 60
# Clocks of two machines never agree exactly. A few seconds of leeway keeps a token signed a
# moment "in the future" from failing at random, without stretching its life in any real way.
LEEWAY_SECONDS = 5


@dataclass(frozen=True)
class ServiceKeys:
    signing: Ed25519PrivateKey  # the Engine's own key: signs calls to Core
    peer: Ed25519PublicKey  # Core's public key: verifies calls from Core


class InvalidServiceToken(Exception):
    pass


def load_keys(env: Mapping[str, str]) -> ServiceKeys | None:
    """Keys as base64 DER (PKCS#8 private, SPKI public): one line each, safe in a .env file.

    None when either is missing, so a misconfigured Engine refuses every call instead of
    accepting unsigned ones.
    """
    private = env.get("ENGINE_SERVICE_PRIVATE_KEY")
    public = env.get("CORE_SERVICE_PUBLIC_KEY")
    if not private or not public:
        return None
    signing = serialization.load_der_private_key(base64.b64decode(private), password=None)
    peer = serialization.load_der_public_key(base64.b64decode(public))
    if not isinstance(signing, Ed25519PrivateKey) or not isinstance(peer, Ed25519PublicKey):
        raise ValueError("service keys must be Ed25519")
    return ServiceKeys(signing=signing, peer=peer)


def sign(keys: ServiceKeys) -> str:
    """A fresh token for one call to Core. Never reuse it: Core refuses a jti it has seen."""
    now = int(time.time())
    claims = {
        "iss": ENGINE,
        "aud": CORE,
        "iat": now,
        "exp": now + LIFETIME_SECONDS,
        "jti": str(uuid4()),
    }
    return jwt.encode(claims, keys.signing, algorithm="EdDSA")


async def verify(db: AsyncEngine, keys: ServiceKeys, authorization: str | None) -> dict[str, Any]:
    """Checks a call from Core and records its jti. Raises InvalidServiceToken on any doubt."""
    if authorization is None or not authorization.startswith("Bearer "):
        raise InvalidServiceToken("missing bearer token")
    try:
        # algorithms is fixed: accepting the token's own "alg" is how "alg: none" attacks work.
        claims: dict[str, Any] = jwt.decode(
            authorization.removeprefix("Bearer "),
            keys.peer,
            algorithms=["EdDSA"],
            audience=ENGINE,
            issuer=CORE,
            leeway=LEEWAY_SECONDS,
            options={"require": ["iss", "aud", "iat", "exp", "jti"]},
        )
    except jwt.PyJWTError as error:
        raise InvalidServiceToken(str(error)) from error
    # A token that claims a longer life than the contract allows is refused, even if signed:
    # the replay window is only as short as the longest token anyone accepts.
    if claims["exp"] - claims["iat"] > LIFETIME_SECONDS:
        raise InvalidServiceToken("token lives longer than 60 s")

    async with db.begin() as conn:
        await conn.execute(text("DELETE FROM engine.service_token_jti WHERE expires_at < now()"))
        inserted = await conn.execute(
            text("""
            INSERT INTO engine.service_token_jti (jti, expires_at) VALUES (:jti, :exp)
            ON CONFLICT (jti) DO NOTHING
            RETURNING jti
            """),
            {
                "jti": str(claims["jti"]),
                "exp": datetime.fromtimestamp(claims["exp"] + LEEWAY_SECONDS, UTC),
            },
        )
        if inserted.first() is None:
            raise InvalidServiceToken("token already used")
    return claims
