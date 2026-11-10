# Shared contract types, written by hand from docs/contracts/ until the JSON Schema -> Pydantic
# codegen exists (roadmap 0.6, postponed for the hackathon). When it lands, this module is
# replaced by the generated one; field names and aliases must already match the contracts (SB-9).
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# openapi.yaml#/components/schemas/CheckType
CheckType = Literal[
    "GITHUB_PR_MERGED",
    "CI_STATUS_GREEN",
    "TESTS_PASSED",
    "HTTP_PROBE",
    "AI_FEATURE_PRESENT",
    "AI_REQUIREMENT_MET",
]


class ContractModel(BaseModel):
    # camelCase on the wire, snake_case in Python (verification-adapters.md section 1).
    # Unknown fields are ignored unless the schema says additionalProperties: false; those
    # models use StrictContractModel, so a typo in a locked config is an error instead of a
    # silently ignored expectation.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class StrictContractModel(ContractModel):
    model_config = ConfigDict(extra="forbid")


SHA256 = r"^sha256:[0-9a-f]{64}$"


# openapi.yaml#/components/schemas/EvidenceLink
class EvidenceLink(ContractModel):
    # REPOSITORY and FILE: ADR-0019 and ADR-0020. Core sets commit_sha on delivery, so the
    # evaluator reads the commit that was delivered, not whatever the branch says later.
    kind: Literal["PULL_REQUEST", "COMMIT", "CI_RUN", "URL", "OTHER", "REPOSITORY", "FILE"]
    url: str
    label: str | None = Field(default=None, max_length=140)
    commit_sha: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    file_hash: str | None = Field(default=None, pattern=SHA256)


# schemas/checks/http-probe.v1.json
class HttpProbeConfig(StrictContractModel):
    url: str = Field(pattern=r"^https://")
    method: Literal["GET", "HEAD"]
    expect_status: int = Field(ge=100, le=599)
    expect_body_contains: list[str] = Field(default_factory=list, max_length=20)
    expect_body_not_contains: list[str] = Field(default_factory=list, max_length=20)
    max_response_ms: int | None = Field(default=None, ge=100, le=30000)
    screenshot: bool = False


# internal-api.yaml#/components/schemas/RunRequest
class LockedVersion(ContractModel):
    version_id: UUID
    snapshot_hash: str = Field(pattern=SHA256)


class RunCriterion(ContractModel):
    criterion_id: UUID
    text: str
    level: Literal["AUTOMATIC", "AI_EVALUATED", "HUMAN"]
    required: bool
    check_type: CheckType | None = None
    # Validated against schemas/checks/* by the adapter's config model right before it runs.
    check_config: dict[str, Any] | None = None


class RunRequest(StrictContractModel):
    run_id: UUID
    submission_id: UUID
    milestone_id: UUID
    contract_id: UUID
    locked_version: LockedVersion
    attempt: int = Field(ge=1)
    locale: Literal["en", "es"]
    # Aware: a naive datetime would be read in the server's timezone and move the deadline.
    deadline_at: AwareDatetime
    github_installation_id: int | None = None
    retention_days: int | None = Field(default=None, ge=30)
    criteria: list[RunCriterion] = Field(min_length=1)
    evidence_links: list[EvidenceLink] = Field(min_length=1)
    notes: str | None = Field(default=None, max_length=5000)


RunStatusValue = Literal["QUEUED", "RUNNING", "COMPLETED", "TIMED_OUT"]
Outcome = Literal["PASSED", "FAILED"]


# internal-api.yaml#/components/schemas/RunStatus
class RunStatus(ContractModel):
    run_id: UUID
    status: RunStatusValue
    outcome: Outcome | None = None


Verdict = Literal["PASS", "FAIL", "UNCERTAIN", "NEEDS_HUMAN"]


AiSource = Literal[
    "DIFF", "SCREENSHOT", "HTTP_RESPONSE", "TEST_REPORT", "NOTES", "REPOSITORY", "FILES"
]


# schemas/checks/ai-check.v2.json, a superset of v1: a locked v1 config still validates.
class AiCheckConfig(StrictContractModel):
    sources: list[AiSource] = Field(min_length=1)
    repository: str | None = None
    url: str | None = Field(default=None, pattern=r"^https://")
    guidance: str = Field(min_length=10, max_length=2000)


InjectionKind = Literal["INSTRUCTION_TO_AI", "VERDICT_MANIPULATION", "HIDDEN_TEXT", "OTHER"]


# schemas/ai/criterion-evaluation.v1.json, $defs/injectionFlag
class InjectionFlag(StrictContractModel):
    evidence_snapshot_id: UUID
    excerpt: str = Field(max_length=300)
    kind: InjectionKind


# schemas/ai/criterion-evaluation.v1.json
class CriterionEvaluation(StrictContractModel):
    verdict: Literal["PASS", "FAIL", "UNCERTAIN"]
    reason: str = Field(min_length=10, max_length=1000)
    evidence_refs: list[UUID] = Field(max_length=20)
    confidence: float = Field(ge=0, le=1)
    injection_flags: list[InjectionFlag] = Field(max_length=20)


CheckVerdict = Literal["PASS", "FAIL", "UNCERTAIN"]


# schemas/ai/criterion-evaluation.v2.json, $defs/check
class EvaluationCheck(StrictContractModel):
    requirement: str = Field(min_length=5, max_length=300)
    source_excerpt: str = Field(min_length=3, max_length=300)
    verdict: CheckVerdict
    finding: str = Field(min_length=5, max_length=600)
    evidence_refs: list[UUID] = Field(max_length=10)
    confidence: float = Field(ge=0, le=1)
    fix: str | None = Field(max_length=400)


# schemas/ai/criterion-evaluation.v2.json. No verdict for the criterion: the Engine computes it
# from the checks (ai-outputs.md section 2.3), so the model cannot simply announce a PASS.
class CriterionEvaluationV2(StrictContractModel):
    checks: list[EvaluationCheck] = Field(min_length=1, max_length=12)
    reason: str = Field(min_length=10, max_length=1000)
    injection_flags: list[InjectionFlag] = Field(max_length=20)


# schemas/ai/ambiguity.v1.json
class Ambiguity(StrictContractModel):
    term: str = Field(max_length=60)
    excerpt: str = Field(max_length=300)
    problem: str = Field(max_length=300)
    alternatives: list[str] = Field(min_length=1, max_length=3)


# schemas/ai/criteria-suggestion.v2.json, $defs/suggestedCriterion
class ModelCriterion(StrictContractModel):
    text: str = Field(min_length=5, max_length=500)
    level: Literal["AUTOMATIC", "AI_EVALUATED", "HUMAN"]
    check_type: CheckType | None
    url: str | None
    guidance: str | None = Field(max_length=2000)
    required: bool
    weight_bps: int
    rationale: str = Field(max_length=500)


# schemas/ai/criteria-suggestion.v2.json
class CriteriaSuggestion(StrictContractModel):
    criteria: list[ModelCriterion] = Field(min_length=1, max_length=20)
    ambiguities: list[Ambiguity] = Field(max_length=20)
    notes: str = Field(max_length=1000)


# internal-api.yaml#/paths/~1internal~1v1~1ai~1criteria:suggest
class SuggestCriteriaRequest(StrictContractModel):
    title: str = Field(min_length=1, max_length=140)
    description: str = Field(max_length=5000)
    contract_title: str | None = Field(default=None, max_length=140)
    locale: Literal["en", "es"]
    requested_by: UUID
