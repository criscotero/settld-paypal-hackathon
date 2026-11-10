import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

from settld_engine import service_auth
from settld_engine.contracts import RunRequest, RunStatus, SuggestCriteriaRequest
from settld_engine.db import create_engine_from_env
from settld_engine.runs import RunConflictError, create_run, get_run_report
from settld_engine.suggestions import ModelFailedError, Suggester, suggester_from_env

HEALTH_TIMEOUT_SECONDS = 3


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.db = create_engine_from_env()
    app.state.keys = service_auth.load_keys(os.environ)
    app.state.suggester = suggester_from_env(os.environ)
    yield
    await app.state.db.dispose()


app = FastAPI(title="Settld Engine", lifespan=lifespan)


def get_db(request: Request) -> AsyncEngine:
    db: AsyncEngine = request.app.state.db
    return db


def get_keys(request: Request) -> service_auth.ServiceKeys | None:
    keys: service_auth.ServiceKeys | None = request.app.state.keys
    return keys


def get_suggester(request: Request) -> Suggester | None:
    suggester: Suggester | None = request.app.state.suggester
    return suggester


class Unauthenticated(Exception):
    pass


async def require_core(
    db: Annotated[AsyncEngine, Depends(get_db)],
    keys: Annotated[service_auth.ServiceKeys | None, Depends(get_keys)],
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    # SB-7: every Engine route but health trusts only Core's service token. A dependency, so it
    # runs before the body is parsed: an unsigned caller learns nothing, not even a 422.
    if keys is None:
        raise Unauthenticated("service keys not configured")
    try:
        await service_auth.verify(db, keys, authorization)
    except service_auth.InvalidServiceToken as error:
        raise Unauthenticated(str(error)) from error


CoreOnly = Depends(require_core)


def problem(
    request: Request,
    status: int,
    code: str,
    title: str,
    detail: str,
    context: dict[str, Any] | None = None,
) -> JSONResponse:
    # errors.md: the same problem+json shape and codes as the public API.
    body: dict[str, Any] = {
        "type": f"https://settld.app/errors/{code.lower()}",
        "title": title,
        "status": status,
        "code": code,
        "detail": detail,
        "requestId": request.headers.get("x-request-id") or str(uuid4()),
    }
    if context is not None:
        body["context"] = context
    return JSONResponse(body, status_code=status, media_type="application/problem+json")


@app.exception_handler(RequestValidationError)
async def validation_failed(request: Request, error: RequestValidationError) -> JSONResponse:
    issues = [
        {"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in error.errors()
    ]
    return problem(
        request,
        422,
        "VALIDATION_FAILED",
        "Invalid request",
        "The body fails its schema",
        {"issues": issues},
    )


@app.exception_handler(Unauthenticated)
async def unauthenticated(request: Request, error: Unauthenticated) -> JSONResponse:
    # The reason stays in the log, not in the answer: a prober gets no hint what to fix.
    return problem(
        request, 401, "UNAUTHENTICATED", "Unauthenticated", "A valid service token is required"
    )


@app.get("/internal/v1/health", operation_id="engineHealth")
async def engine_health(db: Annotated[AsyncEngine, Depends(get_db)]) -> Response:
    # internal-api.yaml: 200 only when the database, S3 and the queue are reachable.
    # TODO: add S3 and the Procrastinate queue when they exist.
    try:
        async with asyncio.timeout(HEALTH_TIMEOUT_SECONDS), db.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except (SQLAlchemyError, OSError, TimeoutError):
        return Response(status_code=503)
    return Response(status_code=200)


@app.put(
    "/internal/v1/runs/{run_id}",
    operation_id="createRun",
    response_model=None,
    dependencies=[CoreOnly],
)
async def create_run_endpoint(
    run_id: UUID,
    body: RunRequest,
    request: Request,
    db: Annotated[AsyncEngine, Depends(get_db)],
    x_request_id: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    if body.run_id != run_id:
        return problem(
            request,
            422,
            "VALIDATION_FAILED",
            "Invalid request",
            "runId in the path and body differ",
        )
    try:
        status, created = await create_run(db, body, correlation_id=x_request_id or str(run_id))
    except RunConflictError as conflict:
        return problem(request, 409, "IDEMPOTENCY_KEY_REUSED", "Run already exists", str(conflict))
    return _status_response(status, 202 if created else 200)


@app.get(
    "/internal/v1/runs/{run_id}",
    operation_id="getRun",
    response_model=None,
    dependencies=[CoreOnly],
)
async def get_run_endpoint(
    run_id: UUID, request: Request, db: Annotated[AsyncEngine, Depends(get_db)]
) -> JSONResponse:
    report = await get_run_report(db, run_id)
    if report is None:
        return problem(request, 404, "NOT_FOUND", "Run not found", f"no run {run_id}")
    return JSONResponse(report, status_code=200)


@app.post(
    "/internal/v1/ai/criteria:suggest",
    operation_id="suggestCriteria",
    response_model=None,
    dependencies=[CoreOnly],
)
async def suggest_criteria_endpoint(
    body: SuggestCriteriaRequest,
    request: Request,
    db: Annotated[AsyncEngine, Depends(get_db)],
    suggester: Annotated[Suggester | None, Depends(get_suggester)],
) -> JSONResponse:
    unavailable = problem(
        request, 503, "AI_UNAVAILABLE", "Suggestions unavailable", "The AI could not answer"
    )
    if suggester is None:
        return unavailable
    try:
        suggestion_id, suggestion = await suggester.suggest(db, body)
    except ModelFailedError:
        return unavailable
    return JSONResponse(
        {
            "suggestionId": str(suggestion_id),
            "criteria": [c.to_wire() for c in suggestion.criteria],
            "ambiguities": [
                a.model_dump(mode="json", by_alias=True) for a in suggestion.ambiguities
            ],
            "notes": suggestion.notes,
        }
    )


def _status_response(status: RunStatus, code: int) -> JSONResponse:
    return JSONResponse(status.model_dump(mode="json", by_alias=True), status_code=code)
