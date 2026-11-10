# The evaluator's tool loop (ADR-0019 decision 4A): the model asks to read, the toolbox reads
# inside the allowlist, and the model answers with checks in the contract's schema.
#
# Why a hand-written loop and not the SDK's tool runner: every read must go through the toolbox
# (allowlist, budget, snapshot first), and the loop has to stop on our limits, keep the turn
# history append-only, and record what was billed even when an answer is invalid. A small loop
# we own is easier to test against a fake model than hooks in a beta helper.
#
# Why tools and structured output in the same request: tool_use turns read, and the final turn
# can only be JSON that matches CriterionEvaluationV2. Free text is never parsed (ai-outputs.md).
#
# Append-only history: assistant turns go back exactly as the API returned them, thinking
# blocks included, and nothing earlier is ever edited. Opus 5.5 checks this (preserved thinking).
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, cast

import anthropic
from pydantic import ValidationError

from settld_engine.contracts import CriterionEvaluationV2
from settld_engine.verification.agent.tools import Toolbox
from settld_engine.verification.model_client import ModelUnavailableError, describe_invalid

# The toolbox stops reads at 20 calls; a few more turns let the model answer after that.
MAX_TURNS = 26

Validation = Literal["VALID", "INVALID_RETRIED", "INVALID_FAILED", "REFUSED"]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass(frozen=True)
class AgentTurn:
    stop: Literal["tool_use", "answer", "refused", "invalid"]
    model: str
    input_tokens: int
    output_tokens: int
    content: list[dict[str, Any]] = field(default_factory=list)  # appended back unchanged
    calls: list[ToolCall] = field(default_factory=list)
    evaluation: CriterionEvaluationV2 | None = None
    invalid_reason: str | None = None
    # Of input_tokens, how many came from the prompt cache or were written to it.
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


class AgentModel(Protocol):
    async def turn(
        self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> AgentTurn: ...


@dataclass(frozen=True)
class AgentOutcome:
    evaluation: CriterionEvaluationV2 | None
    validation: Validation
    model: str
    input_tokens: int
    output_tokens: int
    turns: int
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


async def run_agent(model: AgentModel, *, system: str, user: str, toolbox: Toolbox) -> AgentOutcome:
    messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
    tools = toolbox.definitions()  # fixed for the whole run, so the prompt cache holds
    tokens_in = tokens_out = cache_read = cache_write = 0
    name = "unknown"
    retried = False

    for turn_number in range(1, MAX_TURNS + 1):
        turn = await model.turn(system=system, messages=messages, tools=tools)
        tokens_in += turn.input_tokens
        tokens_out += turn.output_tokens
        cache_read += turn.cache_read_tokens
        cache_write += turn.cache_write_tokens
        name = turn.model

        if turn.stop == "refused":
            return AgentOutcome(
                None, "REFUSED", name, tokens_in, tokens_out, turn_number, cache_read, cache_write
            )
        if turn.stop == "tool_use" and turn.calls:
            messages.append({"role": "assistant", "content": turn.content})
            results = []
            # One at a time: budgets and the order of snapshots stay deterministic, which the
            # audit trail in the AiVerdictRecord relies on.
            for call in turn.calls:
                blocks, is_error = await toolbox.call(call.name, call.input)
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": call.id,
                        "content": blocks,
                        "is_error": is_error,
                    }
                )
            messages.append({"role": "user", "content": results})
            continue
        if turn.stop == "answer" and turn.evaluation is not None:
            validation: Validation = "INVALID_RETRIED" if retried else "VALID"
            return AgentOutcome(
                turn.evaluation,
                validation,
                name,
                tokens_in,
                tokens_out,
                turn_number,
                cache_read,
                cache_write,
            )
        # ai-outputs.md section 1: one retry, telling the model what was wrong (field and error
        # type only: the values were written after reading the seller's content).
        if retried:
            return AgentOutcome(
                None,
                "INVALID_FAILED",
                name,
                tokens_in,
                tokens_out,
                turn_number,
                cache_read,
                cache_write,
            )
        retried = True
        # The invalid turn is left out of the history, not edited: it may hold a tool_use cut off
        # by max_tokens, and a tool_use with no tool_result after it is a 400. The retry follows
        # the last valid turn, so the history stays a prefix of what the API already saw.
        messages.append(
            {
                "role": "user",
                "content": f"Your previous answer was invalid: {turn.invalid_reason}. "
                "Answer again with only the JSON object.",
            }
        )
    return AgentOutcome(
        None, "INVALID_FAILED", name, tokens_in, tokens_out, MAX_TURNS, cache_read, cache_write
    )


class AnthropicAgentClient:
    def __init__(
        self,
        client: anthropic.AsyncAnthropic,
        *,
        model: str,
        effort: Literal["low", "medium", "high", "xhigh", "max"],
    ) -> None:
        self._client = client
        self._model = model
        self._effort = effort

    async def turn(
        self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> AgentTurn:
        try:
            raw = await self._client.beta.messages.with_raw_response.parse(
                model=self._model,
                max_tokens=16_000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                thinking={"type": "adaptive"},
                output_config={"effort": self._effort},
                system=system,
                messages=messages,  # type: ignore[arg-type]
                tools=tools,  # type: ignore[arg-type]
                output_format=CriterionEvaluationV2,
                # Each turn resends the system prompt, the tools and every earlier read: cached,
                # they are billed once instead of once per turn.
                cache_control={"type": "ephemeral"},
            )
        except anthropic.RateLimitError as error:
            raise ModelUnavailableError("rate limited", retryable=True) from error
        except anthropic.APIStatusError as error:
            raise ModelUnavailableError(
                f"Claude API status {error.status_code}", retryable=error.status_code >= 500
            ) from error
        except anthropic.APIConnectionError as error:
            raise ModelUnavailableError(type(error).__name__, retryable=True) from error

        body = cast("dict[str, Any]", await raw.json())
        content: list[dict[str, Any]] = body.get("content") or []
        usage = body.get("usage") or {}
        model = str(body.get("model", self._model))
        cache_read = int(usage.get("cache_read_input_tokens") or 0)
        cache_write = int(usage.get("cache_creation_input_tokens") or 0)
        # The API's input_tokens leaves out what the cache read or wrote; the record counts all of
        # it, so the cost of a call can be told from the record alone.
        tokens = (
            int(usage.get("input_tokens") or 0) + cache_read + cache_write,
            usage.get("output_tokens", 0),
        )
        stop = body.get("stop_reason")

        if stop == "refusal":
            return AgentTurn(
                "refused",
                model,
                *tokens,
                content=content,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
            )
        if stop == "tool_use":
            calls = [
                ToolCall(str(b["id"]), str(b["name"]), dict(b.get("input") or {}))
                for b in content
                if b.get("type") == "tool_use"
            ]
            if not calls:  # nothing to answer with tool_results: an empty user turn is a 400
                reason = "it stopped to use a tool without naming one"
                return AgentTurn(
                    "invalid",
                    model,
                    *tokens,
                    content=content,
                    invalid_reason=reason,
                    cache_read_tokens=cache_read,
                    cache_write_tokens=cache_write,
                )
            return AgentTurn(
                "tool_use",
                model,
                *tokens,
                content=content,
                calls=calls,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
            )
        try:
            parsed = await raw.parse()
        except ValidationError as invalid:
            reason = describe_invalid(invalid)
            return AgentTurn(
                "invalid",
                model,
                *tokens,
                content=content,
                invalid_reason=reason,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
            )
        except ValueError:
            reason = "the answer was not valid JSON"
            return AgentTurn(
                "invalid",
                model,
                *tokens,
                content=content,
                invalid_reason=reason,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
            )
        if parsed.parsed_output is None:
            reason = f"stop_reason={stop}"
            return AgentTurn(
                "invalid",
                model,
                *tokens,
                content=content,
                invalid_reason=reason,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
            )
        return AgentTurn(
            "answer",
            model,
            *tokens,
            content=content,
            evaluation=parsed.parsed_output,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
        )
