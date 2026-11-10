# The contract compiler (ADR-0016): plain words in, checkable criteria out, as a proposal.
#
# Nothing here touches a contract, a guard or money. The form shows the answer, a person edits it,
# and it counts only once every party approves the same locked version (constitution VI).
#
# post_validate is deliberately plain code, for the same reason as ai_evaluation.py: whatever the
# model writes has to get through an if statement. Without it, a confident model could name an
# address nobody agreed on, or a check that can only ever answer UNCERTAIN.
import asyncio
import json
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol
from uuid import UUID, uuid4

import anthropic
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from settld_engine.contracts import (
    AiCheckConfig,
    AiSource,
    Ambiguity,
    CriteriaSuggestion,
    HttpProbeConfig,
    ModelCriterion,
    SuggestCriteriaRequest,
)
from settld_engine.runs import sha256
from settld_engine.verification.model_client import (
    AnthropicModelClient,
    ModelReply,
    ModelUnavailableError,
)

# ADR-0016 decision 3. Someone is waiting at the form, and this call drafts rather than judges.
MODEL = "claude-sonnet-5-5"
PROMPT_ID = "criteria-suggest"
PROMPT_VERSION = "1"
PROMPT_PATH = Path(__file__).resolve().parents[2] / "prompts" / PROMPT_ID / f"{PROMPT_VERSION}.md"

# Under Core's timeout for this call, which is under the web function's limit. Each layer has to
# give up before the one above it, or the person gets a cut connection instead of a clear answer.
TIMEOUT_SECONDS = 50

TOTAL_BPS = 10_000
MIN_GUIDANCE = 10
MAX_NOTES = 1000
# What the evaluator's tools can read (ADR-0019). Fixed here, never chosen by the model, so a
# suggestion cannot promise a check that can only ever answer UNCERTAIN. All of them: the
# delivery decides which actually exist, and an absent source is simply not read.
AI_SOURCES: list[AiSource] = ["HTTP_RESPONSE", "REPOSITORY", "FILES", "NOTES"]

Locale = Literal["en", "es"]
Validation = Literal["VALID", "INVALID_RETRIED", "INVALID_FAILED", "REFUSED"]

_NOTES: Mapping[str, Mapping[Locale, str]] = {
    "no_adapter": {
        "en": "“{text}” cannot be checked automatically yet, so a person decides it.",
        "es": "“{text}” aún no se puede comprobar automáticamente, así que lo decide una persona.",
    },
    "unknown_url": {
        "en": "“{text}” named an address you did not write, so a person decides it.",
        "es": "“{text}” nombraba una dirección que no escribiste, así que lo decide una persona.",
    },
    "no_guidance": {
        "en": "“{text}” did not say what to look for, so a person decides it.",
        "es": "“{text}” no decía qué buscar, así que lo decide una persona.",
    },
    "no_check": {
        "en": "“{text}” named no way to check it, so a person decides it.",
        "es": "“{text}” no indicaba cómo comprobarlo, así que lo decide una persona.",
    },
}


def normalize_weights(weights: list[int]) -> list[int]:
    """The shares of a milestone, summing exactly 10000 with none under 1 (G-MILESTONE-VALID).

    Largest remainder: floors first, then hands the missing basis points to the biggest fractions.
    Plain rounding can end at 9999 or 10001, and then the form opens with a total no one can save.
    """
    if sum(weights) == TOTAL_BPS and all(w >= 1 for w in weights):
        return list(weights)
    positive = [max(w, 1) for w in weights]
    total = sum(positive)
    exact = [w * TOTAL_BPS / total for w in positive]
    result = [max(int(e), 1) for e in exact]
    by_fraction = sorted(range(len(result)), key=lambda i: exact[i] - result[i], reverse=True)
    for i in by_fraction[: max(TOTAL_BPS - sum(result), 0)]:
        result[i] += 1
    # A share raised to the minimum of 1 can leave the sum over: the largest share gives it back.
    while sum(result) > TOTAL_BPS:
        result[result.index(max(result))] -= 1
    return result


_URL_IN_TEXT = re.compile(r"https://[^\s<>\"'`]+")
# Sentence punctuation after an address in prose is not part of the address.
_TRAILING = ".,;:!?)]}"


def _addresses_in(written: str) -> set[str]:
    return {match.rstrip(_TRAILING) for match in _URL_IN_TEXT.findall(written)}


def _usable_url(url: str | None, written: str) -> str | None:
    """Only a whole address the person wrote, character by character. A model can invent a
    believable one, and a criterion pointing at it would check a page nobody agreed on.

    Whole, not a substring: "https://example.com" is inside "https://example.com.au/launch", and
    it is a different site.
    """
    if url is None or url not in _addresses_in(written):
        return None
    return url


@dataclass(frozen=True)
class SuggestedCriterion:
    text: str
    level: Literal["AUTOMATIC", "AI_EVALUATED", "HUMAN"]
    check_type: str | None
    check_config: dict[str, Any] | None
    required: bool
    weight_bps: int
    rationale: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "level": self.level,
            "checkType": self.check_type,
            "checkConfig": self.check_config,
            "required": self.required,
            "weightBps": self.weight_bps,
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class ValidatedSuggestion:
    criteria: list[SuggestedCriterion]
    ambiguities: list[Ambiguity]
    notes: str


def _human(c: ModelCriterion, weight: int) -> SuggestedCriterion:
    return SuggestedCriterion(c.text, "HUMAN", None, None, c.required, weight, c.rationale)


def _validated_criterion(
    c: ModelCriterion, weight: int, written: str
) -> tuple[SuggestedCriterion, str | None]:
    """The criterion that can really run, and why it changed if it did."""
    if c.level == "HUMAN":
        return _human(c, weight), None
    if c.check_type is None:
        return _human(c, weight), "no_check"

    if c.check_type == "HTTP_PROBE":
        url = _usable_url(c.url, written)
        if url is None:
            return _human(c, weight), "unknown_url"
        config = HttpProbeConfig(url=url, method="GET", expect_status=200)
        wire = {"url": url, "method": config.method, "expectStatus": config.expect_status}
        # The level follows the check, not the model's label.
        return SuggestedCriterion(
            c.text, "AUTOMATIC", c.check_type, wire, c.required, weight, c.rationale
        ), None

    if c.check_type in ("AI_FEATURE_PRESENT", "AI_REQUIREMENT_MET"):
        guidance = c.guidance if c.guidance and len(c.guidance) >= MIN_GUIDANCE else c.text
        try:
            ai_config = AiCheckConfig(
                sources=list(AI_SOURCES), url=_usable_url(c.url, written), guidance=guidance
            )
        except ValidationError:
            return _human(c, weight), "no_guidance"
        wire = {"sources": ai_config.sources, "url": ai_config.url, "guidance": ai_config.guidance}
        # Never AUTOMATIC, whatever the model said: that level counts toward a release with no
        # person involved, and an AI check there would let a model move money (constitution VI).
        return SuggestedCriterion(
            c.text, "AI_EVALUATED", c.check_type, wire, c.required, weight, c.rationale
        ), None

    return _human(c, weight), "no_adapter"


def post_validate(
    suggestion: CriteriaSuggestion, *, written: str, locale: Locale
) -> ValidatedSuggestion:
    weights = normalize_weights([c.weight_bps for c in suggestion.criteria])
    criteria: list[SuggestedCriterion] = []
    downgrades: list[str] = []
    for model_criterion, weight in zip(suggestion.criteria, weights, strict=True):
        criterion, why = _validated_criterion(model_criterion, weight, written)
        criteria.append(criterion)
        if why is not None:
            downgrades.append(_NOTES[why][locale].format(text=model_criterion.text))
    # What the code changed goes first: if the limit cuts something, it must not be the reason a
    # criterion the person is reading differs from what the model proposed.
    notes = [*downgrades, *([suggestion.notes] if suggestion.notes else [])]
    return ValidatedSuggestion(criteria, suggestion.ambiguities, "\n".join(notes)[:MAX_NOTES])


_SCOPE_TAG = re.compile(r"<\s*(/?)\s*scope", re.IGNORECASE)


def build_user_message(request: SuggestCriteriaRequest) -> str:
    lines = [f"Contract: {request.contract_title}"] if request.contract_title else []
    lines += [f"Milestone: {request.title}", "", request.description]
    # Without this, the description could close its own data block and write as if it were the
    # prompt. It would only skew its author's own proposal, but the block should mean what it says.
    scope = _SCOPE_TAG.sub(lambda m: f"&lt;{m.group(1)}scope", "\n".join(lines))
    return f"Write the text fields in this language: {request.locale}\n\n<scope>\n{scope}\n</scope>"


class ModelFailedError(Exception):
    """The model gave nothing usable. The form says so and manual editing keeps working."""


class SuggestionModel(Protocol):
    async def evaluate(self, *, system: str, user: str) -> ModelReply[CriteriaSuggestion]: ...


class Suggester:
    def __init__(self, model: SuggestionModel) -> None:
        self._model = model

    async def suggest(
        self, db: AsyncEngine, request: SuggestCriteriaRequest
    ) -> tuple[UUID, ValidatedSuggestion]:
        system = PROMPT_PATH.read_text()
        user = build_user_message(request)
        started = time.monotonic()
        reply, validation = await self._ask(system, user)
        latency_ms = round((time.monotonic() - started) * 1000)

        record_id = uuid4()
        answer = reply.evaluation
        # The call is on the record whatever happened: it was billed, and an absent row would make
        # the failures invisible exactly when someone is trying to find out why suggestions fail.
        await _record(db, record_id, request, reply, validation, system, user, latency_ms)
        if answer is None:
            raise ModelFailedError(validation)
        written = "\n".join([request.contract_title or "", request.title, request.description])
        return record_id, post_validate(answer, written=written, locale=request.locale)

    async def _ask(
        self, system: str, user: str
    ) -> tuple[ModelReply[CriteriaSuggestion], Validation]:
        first: ModelReply[CriteriaSuggestion] | None = None
        try:
            async with asyncio.timeout(TIMEOUT_SECONDS):
                first = await self._model.evaluate(system=system, user=user)
                if first.refused:
                    return first, "REFUSED"
                if first.evaluation is not None:
                    return first, "VALID"
                # ai-outputs.md section 1: one retry, telling the model what was wrong.
                second = await self._model.evaluate(
                    system=system,
                    user=f"{user}\n\nYour previous answer was invalid: {first.invalid_reason}",
                )
        except (ModelUnavailableError, TimeoutError) as error:
            # A first answer that was invalid was still billed: the record has to say so.
            model, tokens_in, tokens_out = (
                (MODEL, 0, 0)
                if first is None
                else (first.model, first.input_tokens, first.output_tokens)
            )
            failed = ModelReply[CriteriaSuggestion](
                model, tokens_in, tokens_out, invalid_reason=str(error)
            )
            return failed, "INVALID_FAILED"
        merged = ModelReply(
            second.model,
            first.input_tokens + second.input_tokens,
            first.output_tokens + second.output_tokens,
            evaluation=second.evaluation,
            refused=second.refused,
        )
        if second.refused:
            return merged, "REFUSED"
        return merged, "INVALID_RETRIED" if second.evaluation is not None else "INVALID_FAILED"


async def _record(
    db: AsyncEngine,
    record_id: UUID,
    request: SuggestCriteriaRequest,
    reply: ModelReply[CriteriaSuggestion],
    validation: Validation,
    system: str,
    user: str,
    latency_ms: int,
) -> None:
    output = (
        None
        if reply.evaluation is None
        else json.dumps(reply.evaluation.model_dump(mode="json", by_alias=True))
    )
    async with db.begin() as conn:
        await conn.execute(
            text("""
            INSERT INTO engine.ai_verdict_records
              (id, purpose, requested_by, model, prompt_id, prompt_version, input_hashes, output,
               validation, usage, latency_ms)
            VALUES (:id, 'CRITERIA_SUGGESTION', :requested_by, :model, :prompt_id, :prompt_version,
                    CAST(:input_hashes AS jsonb), CAST(:output AS jsonb), :validation,
                    CAST(:usage AS jsonb), :latency_ms)
            """),
            {
                "id": record_id,
                "requested_by": request.requested_by,
                "model": reply.model,
                "prompt_id": PROMPT_ID,
                "prompt_version": PROMPT_VERSION,
                "input_hashes": json.dumps(
                    {"system": sha256(system.encode()), "user": sha256(user.encode())}
                ),
                "output": output,
                "validation": validation,
                "usage": json.dumps(
                    {"inputTokens": reply.input_tokens, "outputTokens": reply.output_tokens}
                ),
                "latency_ms": latency_ms,
            },
        )


def suggester_from_env(env: Mapping[str, str]) -> Suggester | None:
    """None without a key: the endpoint answers AI_UNAVAILABLE and the form keeps working."""
    key = env.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    # No SDK retries: a person is waiting, and the deadline above already bounds the call.
    client = anthropic.AsyncAnthropic(api_key=key, timeout=TIMEOUT_SECONDS, max_retries=0)
    return Suggester(AnthropicModelClient(client, CriteriaSuggestion, model=MODEL, effort="medium"))
