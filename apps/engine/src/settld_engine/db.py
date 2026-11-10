import os

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

CONNECT_TIMEOUT_SECONDS = 2


def create_engine_from_env() -> AsyncEngine:
    # Connects as engine_app (SB-3). A missing DATABASE_URL fails at startup, not on a request.
    return create_async_engine(
        os.environ["DATABASE_URL"],
        pool_pre_ping=True,
        connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
    )
