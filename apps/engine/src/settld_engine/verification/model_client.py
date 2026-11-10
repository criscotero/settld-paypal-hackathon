# The one place that calls the Claude API with a structured answer (ADR-0010, ADR-0016).
# Shared by the criteria compiler and the evaluator, so error mapping and token accounting are
# the same everywhere: a reply that fails validation still reports the tokens it was billed.
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import anthropic
from pydantic import BaseModel, ValidationError

from settld_engine.contracts import CriterionEvaluation


class ModelUnavailableError(Exception):
    def __init__(self, reason: str, *, retryable: bool) -> None:
        super().__init__(reason)
        self.retryable = retryable


# OutputT is what the model is constrained to answer: one contract schema per kind of call.
@dataclass(frozen=True)
class ModelReply[OutputT: BaseModel]:
    model: str
    input_tokens: int
    output_tokens: int
    evaluation: OutputT | None = None
    refused: bool = False
    invalid_reason: str | None = None


class ModelClient(Protocol):
    async def evaluate(self, *, system: str, user: str) -> ModelReply[CriterionEvaluation]: ...


class AnthropicModelClient[OutputT: BaseModel]:
    def __init__(
        self,
        client: anthropic.AsyncAnthropic,
        output: type[OutputT],
        *,
        model: str,
        effort: Literal["low", "medium", "high"],
    ) -> None:
        self._client = client
        self._output = output
        self._model = model
        self._effort = effort

    async def evaluate(self, *, system: str, user: str) -> ModelReply[OutputT]:
        try:
            # output_format: the model is constrained to the contract's schema and the SDK
            # validates the reply. Thinking cannot be turned off on this model; effort sets depth.
            # The raw response, so the tokens of a reply that fails validation are still known:
            # they were billed either way.
            raw = await self._client.beta.messages.with_raw_response.parse(
                model=self._model,
                max_tokens=16_000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                thinking={"type": "adaptive"},
                output_config={"effort": self._effort},
                system=system,
                messages=[{"role": "user", "content": user}],
                output_format=self._output,
            )
        except anthropic.RateLimitError as error:
            raise ModelUnavailableError("rate limited", retryable=True) from error
        except anthropic.APIStatusError as error:
            # 400, 401, 403 and 404 mean our request or key is wrong: repeating it cannot help.
            raise ModelUnavailableError(
                f"Claude API status {error.status_code}", retryable=error.status_code >= 500
            ) from error
        except anthropic.APIConnectionError as error:  # includes timeouts
            raise ModelUnavailableError(type(error).__name__, retryable=True) from error

        try:
            response = await raw.parse()
        except ValidationError as invalid:
            return self._invalid(await raw.json(), describe_invalid(invalid))
        except ValueError:
            return self._invalid(await raw.json(), "the answer was not valid JSON")

        model, tokens_in, tokens_out = (
            response.model,
            response.usage.input_tokens,
            response.usage.output_tokens,
        )
        if response.stop_reason == "refusal":
            return ModelReply(model, tokens_in, tokens_out, refused=True)
        if response.parsed_output is None:
            reason = f"stop_reason={response.stop_reason}"
            return ModelReply(model, tokens_in, tokens_out, invalid_reason=reason)
        return ModelReply(model, tokens_in, tokens_out, evaluation=response.parsed_output)

    def _invalid(self, body: Any, reason: str) -> ModelReply[OutputT]:
        usage = body.get("usage", {})
        return ModelReply(
            body.get("model", self._model),
            usage.get("input_tokens", 0),
            usage.get("output_tokens", 0),
            invalid_reason=reason,
        )


def describe_invalid(invalid: ValidationError) -> str:
    """Field and error type, never the value. This goes back into the next prompt, outside any
    data block, and the value is what the model wrote after reading the seller's content.
    """
    return "; ".join(
        f"{'.'.join(str(part) for part in e['loc'])}: {e['type']}"
        for e in invalid.errors(include_input=False, include_url=False, include_context=False)
    )
