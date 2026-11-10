# Post-validation of a CriterionEvaluation (ai-outputs.md section 2.3, ADR-0010).
#
# Deliberately plain code with no model anywhere near it. A prompt injection that fools the model
# into a confident PASS still has to get through here, and nothing in the evidence can argue with
# an if statement. This layer only ever lowers a PASS; it never raises anything to PASS.
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from settld_engine.contracts import CriterionEvaluation, InjectionFlag

# Q-AI-1, the contract's default. Below it the buyer should read the reason, not trust the label.
MIN_PASS_CONFIDENCE = 0.8

Locale = Literal["en", "es"]

_NOTES: dict[str, dict[Locale, str]] = {
    "no_evidence": {
        "en": "Marked uncertain: the assessment cites no evidence.",
        "es": "Marcado como incierto: la evaluación no cita evidencia.",
    },
    "unknown_evidence": {
        "en": "Marked uncertain: the assessment cites evidence it was not given.",
        "es": "Marcado como incierto: la evaluación cita evidencia que no recibió.",
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
}


@dataclass(frozen=True)
class FinalEvaluation:
    verdict: Literal["PASS", "FAIL", "UNCERTAIN"]
    reason: str
    evidence_refs: list[UUID]
    flags: list[InjectionFlag]


def merge_flags(
    from_model: list[InjectionFlag], from_scan: list[InjectionFlag], supplied: Mapping[UUID, str]
) -> list[InjectionFlag]:
    merged: dict[tuple[UUID, str, str], InjectionFlag] = {}
    for flag in [*from_scan, *from_model]:
        # A flag on a snapshot that does not exist could not be shown to anyone.
        if flag.evidence_snapshot_id in supplied:
            merged.setdefault((flag.evidence_snapshot_id, flag.excerpt, flag.kind), flag)
    return list(merged.values())


def _why_not_pass(
    evaluation: CriterionEvaluation,
    known_refs: list[UUID],
    supplied: Mapping[UUID, str],
    flags: list[InjectionFlag],
) -> str | None:
    if not evaluation.evidence_refs:
        return "no_evidence"  # DM-INV-4
    if len(known_refs) != len(evaluation.evidence_refs):
        return "unknown_evidence"
    if all(supplied[ref] == "NOTES" for ref in known_refs):
        return "only_claims"
    if evaluation.confidence < MIN_PASS_CONFIDENCE:
        return "low_confidence"
    if flags:
        return "injection"
    return None


def post_validate(
    evaluation: CriterionEvaluation,
    supplied: Mapping[UUID, str],
    scan_flags: list[InjectionFlag],
    locale: Locale,
) -> FinalEvaluation:
    """`supplied` maps each snapshot the model was shown to its EvidenceKind."""
    flags = merge_flags(evaluation.injection_flags, scan_flags, supplied)
    # Made-up ids never reach the database, whatever the verdict.
    known_refs = [ref for ref in evaluation.evidence_refs if ref in supplied]

    if evaluation.verdict == "PASS":
        problem = _why_not_pass(evaluation, known_refs, supplied, flags)
        if problem is not None:
            reason = f"{evaluation.reason} {_NOTES[problem][locale]}"
            return FinalEvaluation("UNCERTAIN", reason, known_refs, flags)

    return FinalEvaluation(evaluation.verdict, evaluation.reason, known_refs, flags)
