# The adapter interface from verification-adapters.md section 1. The contract is the source:
# change it there first, then here.
#
# Why adapters return values instead of writing results: the orchestrator owns the transaction
# that stores a CriterionResult together with its outbox row (constitution IV). An adapter that
# wrote to the database or emitted events itself could leave a verdict without its event, or
# report one twice on a retry.
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar
from uuid import UUID

from pydantic import BaseModel

from settld_engine.contracts import CheckType, EvidenceLink, InjectionFlag

TConfig = TypeVar("TConfig", bound=BaseModel)

# REPOSITORY_FILE and DELIVERED_FILE: verification-adapters.md 0.4.0 (ADR-0019).
EvidenceKind = Literal[
    "PR_METADATA",
    "CI_RUN",
    "TEST_REPORT",
    "HTTP_RESPONSE",
    "SCREENSHOT",
    "DIFF",
    "NOTES",
    "REPOSITORY_FILE",
    "DELIVERED_FILE",
]


class AdapterPolicy(BaseModel):
    timeout_seconds: float
    max_attempts: int


class CheckInput[TConfig: BaseModel](BaseModel):
    run_id: UUID
    criterion_id: UUID
    criterion_text: str  # from the locked version (RunRequest)
    check_type: CheckType
    config: TConfig  # from the locked version, never from the submission
    evidence_links: list[EvidenceLink]  # from the submission
    notes: str | None = None  # from the submission: untrusted, and a claim rather than evidence
    locale: Literal["en", "es"] = "en"


class AiCall(BaseModel):
    """What constitution VI requires us to keep about a verdict from a model."""

    model: str
    prompt_id: str
    prompt_version: str
    # "system" and "user" hashes, and for the evaluator agent "toolCalls": each read in order,
    # with the snapshot and hash it produced, so a later audit can replay what the model saw.
    input_hashes: dict[str, Any]
    output: dict[str, Any] | None
    validation: Literal["VALID", "INVALID_RETRIED", "INVALID_FAILED", "REFUSED"]
    usage: dict[str, int]
    latency_ms: int


class SnapshotRef(BaseModel):
    id: UUID
    hash: str  # "sha256:<hex>"


class Passed(BaseModel):
    verdict: Literal["PASS"] = "PASS"
    reason: str
    evidence_refs: list[UUID]  # at least one
    injection_flags: list[InjectionFlag] = []
    checks: list[dict[str, Any]] = []  # AI criteria only, in the contract's EvaluationCheck shape


class Failed(BaseModel):
    verdict: Literal["FAIL"] = "FAIL"
    reason: str
    evidence_refs: list[UUID]
    injection_flags: list[InjectionFlag] = []
    checks: list[dict[str, Any]] = []


class Uncertain(BaseModel):
    verdict: Literal["UNCERTAIN"] = "UNCERTAIN"
    reason: str
    evidence_refs: list[UUID]
    injection_flags: list[InjectionFlag] = []
    checks: list[dict[str, Any]] = []


class AdapterError(BaseModel):
    # Internal only: the orchestrator retries it or stores UNCERTAIN. Never reaches a
    # CriterionResult, so a crash can never read as PASS or FAIL.
    verdict: Literal["ERROR"] = "ERROR"
    retryable: bool
    reason: str


CheckOutcome = Passed | Failed | Uncertain | AdapterError


class CheckContext(Protocol):
    async def snapshot(
        self, kind: EvidenceKind, data: bytes, *, content_type: str, source_url: str | None = None
    ) -> SnapshotRef:
        """Stores the bytes and records an EvidenceSnapshot with their hash (constitution VII).

        ADR-0008 decision 3: Postgres in the `engine` schema for the hackathon; S3 with Object
        Lock before production.
        """
        ...

    def record_ai(self, call: AiCall) -> None:
        """Stored in the same transaction as the result it produced, like the snapshots."""
        ...

    async def github_token(self, repository: str) -> str:
        """Short-lived GitHub App installation token, repository-scoped, read-only."""
        ...

    @property
    def deadline(self) -> datetime: ...


class VerificationAdapter(Protocol[TConfig]):
    check_types: frozenset[CheckType]
    config_model: type[TConfig]
    policy: AdapterPolicy

    async def execute(self, check: CheckInput[TConfig], ctx: CheckContext) -> CheckOutcome: ...
