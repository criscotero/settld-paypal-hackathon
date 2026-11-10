# From the model's checks to the criterion's verdict (ADR-0019, ai-outputs.md section 2.3).
#
# Why the model does not write the criterion's verdict: a single "PASS" is the one word a prompt
# injection needs. Here every check has to stand on its own evidence, and the verdict is an if
# statement over checks, which nothing in a seller's page can argue with.
#
# Why checks are matched against the approved text: the evaluator could otherwise grow the
# contract ("and it must load in under a second") and fail work for something nobody agreed to.
# A check that cannot quote the criterion or the guidance is dropped, and the reason says so.
#
# Like post_validate (v1), this layer only ever lowers a check: nothing becomes PASS here.
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from settld_engine.contracts import CriterionEvaluationV2, EvaluationCheck, InjectionFlag
from settld_engine.verification.ai_evaluation import MIN_PASS_CONFIDENCE, Locale, merge_flags

Verdict = Literal["PASS", "FAIL", "UNCERTAIN"]

_NOTES: dict[str, dict[Locale, str]] = {
    "no_evidence": {
        "en": "Marked uncertain: it cites no evidence.",
        "es": "Marcado como incierto: no cita evidencia.",
    },
    "unknown_evidence": {
        "en": "Marked uncertain: it cites evidence the verifier never read.",
        "es": "Marcado como incierto: cita evidencia que el verificador no leyó.",
    },
    "only_claims": {
        "en": "Marked uncertain: it rests only on the seller's notes, which are a claim.",
        "es": "Marcado como incierto: se apoya solo en las notas del vendedor, que son una"
        " afirmación.",
    },
    "low_confidence": {
        "en": "Marked uncertain: the confidence is too low to count as a pass.",
        "es": "Marcado como incierto: la confianza es muy baja para contar como aprobado.",
    },
    "injection": {
        "en": "Marked uncertain: the evidence may be trying to influence the verifier.",
        "es": "Marcado como incierto: la evidencia podría estar intentando influir en el"
        " verificador.",
    },
    "fail_without_evidence": {
        "en": "Marked uncertain: a failure has to be shown with evidence, like a pass.",
        "es": "Marcado como incierto: una falla tiene que mostrarse con evidencia, igual que"
        " un aprobado.",
    },
}
_DISCARDED: dict[Locale, str] = {
    "en": "{n} check(s) were left out because they ask for something the contract does not.",
    "es": "Se dejaron fuera {n} check(s) porque piden algo que el contrato no pide.",
}
_NOTHING_LEFT: dict[Locale, str] = {
    "en": "No check could be tied to the agreed text, so a person should decide.",
    "es": "Ningún check se pudo ligar al texto acordado; debe decidirlo una persona.",
}

_SPACES = re.compile(r"\s+")


def _normalize(text: str) -> str:
    return _SPACES.sub(" ", text).strip().casefold()


@dataclass(frozen=True)
class AggregateResult:
    verdict: Verdict
    reason: str
    evidence_refs: list[UUID]
    flags: list[InjectionFlag]
    checks: list[dict[str, Any]]  # EvaluationCheck in openapi.yaml, with its note


def _why_not(
    check: EvaluationCheck, known: list[UUID], supplied: Mapping[UUID, str], flagged: bool
) -> str | None:
    if check.verdict == "UNCERTAIN":
        return None
    if check.verdict == "FAIL":
        if not known:
            return "fail_without_evidence"
        return "unknown_evidence" if len(known) != len(check.evidence_refs) else None
    if not check.evidence_refs:
        return "no_evidence"  # DM-INV-4
    if len(known) != len(check.evidence_refs):
        return "unknown_evidence"
    if all(supplied[ref] == "NOTES" for ref in known):
        return "only_claims"
    if check.confidence < MIN_PASS_CONFIDENCE:
        return "low_confidence"
    if flagged:
        return "injection"
    return None


def aggregate(
    evaluation: CriterionEvaluationV2,
    *,
    supplied: Mapping[UUID, str],
    scan_flags: list[InjectionFlag],
    approved_text: Sequence[str],
    locale: Locale,
) -> AggregateResult:
    """`supplied` maps each snapshot the model was shown to its EvidenceKind."""
    flags = merge_flags(evaluation.injection_flags, scan_flags, supplied)
    approved = [_normalize(t) for t in approved_text]

    kept: list[dict[str, Any]] = []
    verdicts: list[Verdict] = []
    refs: list[UUID] = []
    discarded = 0
    for check in evaluation.checks:
        excerpt = _normalize(check.source_excerpt)
        if not any(excerpt in text for text in approved):
            discarded += 1
            continue
        known = [ref for ref in check.evidence_refs if ref in supplied]
        problem = _why_not(check, known, supplied, bool(flags))
        verdict: Verdict = check.verdict if problem is None else "UNCERTAIN"
        verdicts.append(verdict)
        refs.extend(ref for ref in known if ref not in refs)
        kept.append(
            {
                "requirement": check.requirement,
                "sourceExcerpt": check.source_excerpt,
                "verdict": verdict,
                "finding": check.finding,
                "evidenceRefs": [str(ref) for ref in known],
                "fix": check.fix,
                "note": None if problem is None else _NOTES[problem][locale],
            }
        )

    reason = evaluation.reason
    if discarded:
        reason = f"{reason} {_DISCARDED[locale].format(n=discarded)}"
    if not verdicts:
        return AggregateResult("UNCERTAIN", f"{reason} {_NOTHING_LEFT[locale]}", refs, flags, kept)

    criterion: Verdict
    if "FAIL" in verdicts:
        criterion = "FAIL"
    elif all(v == "PASS" for v in verdicts):
        criterion = "PASS"
    else:
        criterion = "UNCERTAIN"
    return AggregateResult(criterion, reason, refs, flags, kept)
