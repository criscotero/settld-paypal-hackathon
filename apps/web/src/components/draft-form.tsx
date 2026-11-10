"use client";
// Editor for ContractDraftInput (openapi.yaml). Local state keeps amounts as the
// text people type; they become Money only on submit (lib/money.ts). Domain rules
// (due date in the future, at least one required criterion, ...) are NOT checked
// here: Core API checks them on submit (G-MILESTONE-VALID) and the UI shows its answer.
import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import type { SyntheticEvent } from "react";
import { useRouter } from "next/navigation";
import { createContract, replaceDraft, sendInvitation, suggestCriteria } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { CriteriaSuggestion, DraftInput, Schemas } from "@/lib/api-types";
import { afterCreatePath } from "@/lib/after-create";
import type { WhoWillWork } from "@/lib/after-create";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { formatMoney, parseMoney, toMajorString } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ActionError } from "@/lib/problem";
import { aiCheckConfig, guidanceOf, keptFieldsOf } from "@/lib/ai-check";
import type { KeptFields } from "@/lib/ai-check";
import { codeMap } from "@/lib/criterion-code";
import { submitWhenSettled, updateCriterion } from "@/lib/criteria-grid";
import { originAfterEdit, wouldReplaceWork } from "@/lib/suggestions";
import { evenWeights, formatCountdown, formatWeight, parseWeightPercent } from "@/lib/weights";
import { ErrorBox } from "./error-box";
import { CriteriaGridLoader } from "./grid/criteria-grid-loader";

type Level = Schemas["CriterionInput"]["level"];
type CheckType = Schemas["CheckType"];

type CriterionForm = {
  key: number;
  id?: string;
  text: string;
  level: Level;
  required: boolean;
  // Percentage as typed ("33.34"); sent as basis points.
  weight: string;
  checkType: CheckType | "";
  probeUrl: string;
  guidance: string;
  kept: KeptFields;
  origin: Schemas["CriterionInput"]["origin"];
  aiSuggestionId: string | null;
  // Why the compiler proposed it. Shown until the person edits the criterion, and never saved.
  rationale: string | undefined;
};
type MilestoneForm = { key: number; id?: string; title: string; description: string; amount: string; dueDate: string; criteria: CriterionForm[] };
type FormState = { title: string; description: string; currency: string; terms: Schemas["Terms"]; milestones: MilestoneForm[] };

// The Engine has no adapter yet for GitHub, CI or tests (ADR-0008, decision 4): they always answer
// UNCERTAIN, so offering "Settld checks it by itself" would promise something that never happens.
// `unavailable` keeps them readable on a draft that already uses one, and out of new choices.
const CHECK_TYPES: { value: CheckType; label: string; level: Level; unavailable?: true }[] = [
  { value: "HTTP_PROBE", label: "A URL answers (HTTP probe)", level: "AUTOMATIC" },
  { value: "GITHUB_PR_MERGED", label: "GitHub pull request merged (not available yet)", level: "AUTOMATIC", unavailable: true },
  { value: "CI_STATUS_GREEN", label: "CI is green (not available yet)", level: "AUTOMATIC", unavailable: true },
  { value: "TESTS_PASSED", label: "Tests passed (not available yet)", level: "AUTOMATIC", unavailable: true },
  { value: "AI_FEATURE_PRESENT", label: "Feature is present", level: "AI_EVALUATED" },
  { value: "AI_REQUIREMENT_MET", label: "Requirement is met", level: "AI_EVALUATED" },
];

// The three verification levels (domain-model.md: Criterion.level), explained in
// one line each so the buyer knows what they are signing up for.
const LEVELS: { level: Level; label: string; hint: string; defaultCheck: CheckType | "" }[] = [
  { level: "AUTOMATIC", label: "Automatic", hint: "Settld checks it by itself, e.g. a URL answers.", defaultCheck: "HTTP_PROBE" },
  { level: "AI_EVALUATED", label: "AI check", hint: "An AI reads the delivered page and the seller's notes and gives you its opinion. It only counts if you approve it.", defaultCheck: "AI_REQUIREMENT_MET" },
  { level: "HUMAN", label: "Human review", hint: "The buyer decides. Slower, and hard to prove if you disagree.", defaultCheck: "" },
];

// Seconds. One minute is the floor (D6), meant for agents; people usually want days.
const COUNTDOWN_PRESETS = [60, 3_600, 86_400, 172_800, 259_200, 604_800];

const NARROW = "(max-width: 767px)";
function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

let nextKey = 0;
const key = () => ++nextKey;

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const blankCriterion = (weight = ""): CriterionForm => ({ key: key(), text: "", level: "HUMAN", required: true, weight, checkType: "", probeUrl: "", guidance: "", kept: keptFieldsOf(null), origin: "USER_WRITTEN", aiSuggestionId: null, rationale: undefined });
const blankMilestone = (): MilestoneForm => ({ key: key(), title: "", description: "", amount: "", dueDate: inDays(14), criteria: [blankCriterion("100")] });

function probeUrlOf(config: unknown): string {
  const url = (config as { url?: unknown } | null)?.url;
  return typeof url === "string" ? url : "";
}

function criterionFormOf(c: Schemas["CriterionInput"] & { rationale?: string }): CriterionForm {
  return {
    key: key(),
    id: c.id,
    text: c.text,
    level: c.level,
    required: c.required,
    weight: formatWeight(c.weightBps),
    checkType: c.checkType ?? "",
    probeUrl: probeUrlOf(c.checkConfig),
    guidance: guidanceOf(c.checkConfig),
    kept: keptFieldsOf(c.checkConfig),
    origin: c.origin,
    aiSuggestionId: c.aiSuggestionId ?? null,
    rationale: c.rationale,
  };
}

function fromSnapshot(s: DraftInput): FormState {
  return {
    title: s.title,
    description: s.description ?? "",
    currency: s.currency,
    terms: s.terms,
    milestones: s.milestones.map((m) => ({
      key: key(),
      id: m.id,
      title: m.title,
      description: m.description ?? "",
      amount: toMajorString(m.amount.amountMinor, m.amount.currency),
      dueDate: m.dueDate,
      criteria: m.criteria.map(criterionFormOf),
    })),
  };
}

const EMPTY: FormState = {
  title: "",
  description: "",
  currency: "USD",
  // platformFeeBps is readOnly: Core API ignores what we send and freezes its own (ADR-0004, H1-G4).
  terms: { releaseCountdownSeconds: 172_800, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME", platformFeeBps: 0 },
  milestones: [],
};

// Ids are kept on edit so Core API updates the same milestone instead of creating
// a new one: milestone rows carry runtime state, and a new id would lose it.
function toDraftInput(f: FormState): { ok: true; draft: DraftInput } | { ok: false; error: ActionError } {
  const issues: string[] = [];
  const milestones = f.milestones.map((m, i) => {
    const money = parseMoney(m.amount, f.currency);
    if (!money.ok) issues.push(`Milestone ${String(i + 1)} amount: ${money.reason}`);
    return {
      ...(m.id === undefined ? {} : { id: m.id }),
      title: m.title,
      description: m.description,
      amount: { amountMinor: money.ok ? money.amountMinor : 0, currency: f.currency },
      dueDate: m.dueDate,
      criteria: m.criteria.map((c, j) => {
        const weight = parseWeightPercent(c.weight);
        if (!weight.ok) issues.push(`Milestone ${String(i + 1)}, criterion ${String(j + 1)} weight: ${weight.reason}`);
        return {
        ...(c.id === undefined ? {} : { id: c.id }),
        text: c.text,
        level: c.level,
        required: c.required,
        weightBps: weight.ok ? weight.bps : 0,
        checkType: c.level === "HUMAN" || c.checkType === "" ? null : c.checkType,
        checkConfig: c.level === "HUMAN" ? null : c.level === "AI_EVALUATED" ? aiCheckConfig(c.guidance, c.probeUrl, c.kept) : c.checkType === "HTTP_PROBE" ? { url: c.probeUrl, method: "GET", expectStatus: 200 } : null,
        origin: c.origin,
        aiSuggestionId: c.aiSuggestionId,
        };
      }),
    };
  });
  // Only what cannot be sent at all is stopped here (a non-number amount or weight has no
  // wire form). Weights that do not add up to 100% are G-MILESTONE-VALID: Core API's call.
  if (issues.length > 0) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Some amounts or weights are not valid.", issues, requestId: null } };
  return { ok: true, draft: { title: f.title, description: f.description, currency: f.currency, terms: f.terms, milestones: milestones as DraftInput["milestones"] } };
}

type Props =
  | { mode: "create" }
  | { mode: "edit"; contractId: string; version: number; snapshot: DraftInput; supersedes: boolean };

function SectionTitle({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">{n}</span>
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="text-sm text-slate-500">{hint}</p>
      </div>
    </div>
  );
}

// New contract's "Who will do the work?" (docs/mejoras-pendientes.md, 3).
const WHO_OPTIONS = [
  ["INVITE", "Invite a seller by email", "We email them as soon as the contract is created. They see the draft and accept it there."],
  ["PUBLISH", "Publish as an open project", "Sellers find it under Open projects. You review it and publish it on the next page."],
  ["LATER", "Decide later", "The contract stays a draft that only you can see."],
] as const;

export function DraftForm(props: Props) {
  const [form, setForm] = useState<FormState>(() => (props.mode === "edit" ? fromSnapshot(props.snapshot) : { ...EMPTY, milestones: [blankMilestone()] }));
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  // Same rule as ActionForm (ADR-0005): one key per mounted form. Success redirects
  // away, so it never needs to rotate.
  const [idempotencyKey] = useState(newIdempotencyKey);
  // Its own key: the invitation is a different request from the create, retried on its own.
  const [inviteKey] = useState(newIdempotencyKey);
  const [who, setWho] = useState<WhoWillWork["kind"]>("LATER");
  const [inviteEmail, setInviteEmail] = useState("");
  const router = useRouter();
  // Per milestone, by its form key. One request at a time: each click is a paid model call.
  const [suggesting, setSuggesting] = useState<number | null>(null);
  const [suggested, setSuggested] = useState<Record<number, Pick<CriteriaSuggestion, "ambiguities" | "notes">>>({});
  const [suggestError, setSuggestError] = useState<Record<number, ActionError | undefined>>({});
  // ADR-0022, decision 3.A, as the owner set it: the cards by default, the grid one click away, and
  // the cards only on a narrow screen, where editing cells is hard. The demo's main flow keeps the
  // view it always had unless the buyer asks for the table.
  const [criteriaView, setCriteriaView] = useState<"table" | "cards">("cards");
  // One "finish your edit" per open grid, by milestone key, run before every submit (ADR-0022).
  const gridFlushes = useRef(new Map<number, () => boolean>());
  const formRef = useRef<HTMLFormElement>(null);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);

  const setMilestone = (mk: number, patch: Partial<MilestoneForm>) => {
    setForm((f) => ({ ...f, milestones: f.milestones.map((m) => (m.key === mk ? { ...m, ...patch } : m)) }));
  };
  // The only way a criterion changes, from the cards or the grid (lib/criteria-grid.ts).
  const setCriterion = (mk: number, ck: number, patch: Partial<CriterionForm>) => {
    setForm((f) => ({ ...f, milestones: f.milestones.map((m) => (m.key === mk ? { ...m, criteria: updateCriterion(m.criteria, ck, patch) } : m)) }));
  };
  // "M1-C2" for every criterion, by its form key: the same code in the cards, the grid and, once the
  // contract is approved, the AI audit. It renumbers while the draft is edited (lib/criterion-code.ts).
  const codes = codeMap(form.milestones, (c) => c.key);

  // Live summary only; the stored amounts are whatever Core API saves.
  const amounts = form.milestones.map((m) => parseMoney(m.amount, form.currency));
  const total = amounts.reduce((sum, a) => sum + (a.ok ? a.amountMinor : 0), 0);
  const allAmountsValid = amounts.every((a) => a.ok);

  async function suggestFor(m: MilestoneForm) {
    if (wouldReplaceWork(m.criteria) && !window.confirm("Replace the criteria of this milestone with suggestions?")) return;
    setSuggesting(m.key);
    setSuggestError((all) => ({ ...all, [m.key]: undefined }));
    setSuggested((all) => ({ ...all, [m.key]: { ambiguities: [], notes: "" } }));
    // A failed call leaves the form exactly as it was: suggestions never block writing by hand.
    const result = await suggestCriteria({ title: m.title, description: m.description, contractTitle: form.title }).catch(
      (): { ok: false; error: ActionError } => ({ ok: false, error: { code: "AI_UNAVAILABLE", message: "Suggestions are unavailable right now. You can write the criteria yourself.", issues: [], requestId: null } }),
    );
    setSuggesting(null);
    if (!result.ok) {
      setSuggestError((all) => ({ ...all, [m.key]: result.error }));
      return;
    }
    setMilestone(m.key, { criteria: result.suggestion.criteria.map(criterionFormOf) });
    setSuggested((all) => ({ ...all, [m.key]: { ambiguities: result.suggestion.ambiguities, notes: result.suggestion.notes } }));
  }

  function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    // A cell still being edited would be submitted with its old value. Finish every edit first; if
    // one was open, submit again on the next turn, when the form state has it.
    // The retry is a new submit, not a stored call to send: this render's send still sees the old state.
    submitWhenSettled(gridFlushes.current.values(), send, () => {
      setTimeout(() => {
        formRef.current?.requestSubmit();
      }, 0);
    });
  }

  function send() {
    const parsed = toDraftInput(form);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    startTransition(async () => {
      if (props.mode === "edit") {
        // Success redirects (the promise never resolves with a value); a value is a problem.
        setError(await replaceDraft(props.contractId, props.version, parsed.draft));
        return;
      }
      const choice: WhoWillWork = who === "INVITE" ? { kind: "INVITE", email: inviteEmail.trim() } : { kind: who };
      const created = await createContract(idempotencyKey, parsed.draft);
      if (!("id" in created)) {
        setError(created);
        return;
      }
      // Two actions, not one: each Server Action is one Core API call (ADR-0005). If the
      // invitation fails the contract still exists, so we go to it and say why there.
      const inviteError = choice.kind === "INVITE" ? await sendInvitation(created.id, choice.email, inviteKey) : null;
      router.push(afterCreatePath(created.id, choice, inviteError));
    });
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        {props.mode === "edit" && props.supersedes && (
          <p className="rounded-lg border-l-4 border-accent bg-white p-3 text-sm shadow-sm">
            This version is waiting for approval. Saving creates version {props.version + 1} and both parties must approve again.
          </p>
        )}

        <Card className="p-6">
          <SectionTitle n={1} title="What is the work?" hint="A short name both of you will recognize, and the context the seller needs." />
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <div className="space-y-1.5">
              <Label htmlFor="title">Contract title *</Label>
              <Input id="title" required maxLength={140} value={form.title} onChange={(e) => { setForm({ ...form, title: e.target.value }); }} placeholder="Acme website rebuild" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Select id="currency" value={form.currency} onChange={(e) => { setForm({ ...form, currency: e.target.value }); }}>
                {["USD", "EUR", "MXN", "BRL", "JPY"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" maxLength={5000} value={form.description} onChange={(e) => { setForm({ ...form, description: e.target.value }); }} placeholder="Scope, links to designs, anything the seller should know." />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <SectionTitle n={2} title="Milestones" hint="Each milestone is one step of the contract: paid separately, when its criteria are met." />
          {!narrow && (
            <div role="group" aria-label="Show criteria as" className="-mt-2 mb-4 flex items-center gap-1 text-sm">
              <span className="mr-1 text-slate-500">Criteria as</span>
              {(["table", "cards"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={criteriaView === v}
                  onClick={() => { setCriteriaView(v); }}
                  className={cn("rounded-md px-3 py-1.5 font-medium transition-colors", criteriaView === v ? "bg-navy text-white" : "text-slate-600 hover:bg-slate-100")}
                >
                  {v === "table" ? "Table" : "Cards"}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-4">
            {form.milestones.map((m, i) => {
              const amount = amounts[i];
              const checked = m.criteria.filter((c) => c.level !== "HUMAN").length;
              const weights = m.criteria.map((c) => parseWeightPercent(c.weight));
              const weightSum = weights.reduce((sum, w) => sum + (w.ok ? w.bps : 0), 0);
              return (
                <div key={m.key} className="overflow-hidden rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between gap-4 border-b border-slate-100 bg-slate-50 px-4 py-2">
                    <p className="text-sm font-bold">
                      Step {i + 1}
                      {m.title !== "" && <span className="font-normal text-slate-500"> · {m.title}</span>}
                    </p>
                    {form.milestones.length > 1 && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setForm({ ...form, milestones: form.milestones.filter((x) => x.key !== m.key) }); }}>
                        Remove step
                      </Button>
                    )}
                  </div>
                  <div className="space-y-4 p-4">
                    <div className="grid gap-4 sm:grid-cols-[1fr_9rem_10rem]">
                      <div className="space-y-1.5">
                        <Label>What gets delivered *</Label>
                        <Input required maxLength={140} placeholder="Landing page live" value={m.title} onChange={(e) => { setMilestone(m.key, { title: e.target.value }); }} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Amount ({form.currency}) *</Label>
                        <Input
                          required
                          inputMode="decimal"
                          placeholder="1500.00"
                          value={m.amount}
                          aria-invalid={m.amount !== "" && amount?.ok === false}
                          onChange={(e) => { setMilestone(m.key, { amount: e.target.value }); }}
                        />
                        {m.amount !== "" && amount !== undefined && !amount.ok && <p className="text-xs text-red-600">{amount.reason}</p>}
                      </div>
                      <div className="space-y-1.5">
                        <Label>Due date *</Label>
                        <Input required type="date" value={m.dueDate} onChange={(e) => { setMilestone(m.key, { dueDate: e.target.value }); }} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Details</Label>
                      <Textarea className="min-h-14" value={m.description} onChange={(e) => { setMilestone(m.key, { description: e.target.value }); }} />
                    </div>

                    {/* Locked while drafting: what is typed here now would be replaced by the answer. */}
                    <fieldset disabled={suggesting === m.key} className="min-w-0 space-y-2">
                      <div className="flex items-baseline justify-between gap-4">
                        <Label>How do we know it is done? *</Label>
                        <span className="text-xs text-slate-500">
                          {checked} of {m.criteria.length} checked without a human
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent-soft p-3">
                        <Button
                          type="button"
                          size="sm"
                          disabled={m.title.trim() === "" || suggesting !== null}
                          onClick={() => { void suggestFor(m); }}
                        >
                          {suggesting === m.key ? "Drafting criteria…" : "Suggest criteria with AI"}
                        </Button>
                        <p className="min-w-48 flex-1 text-xs text-slate-600">
                          Describe the work above. AI proposes checkable criteria and weights, and you edit them. Nothing is saved until you save.
                        </p>
                      </div>
                      {suggestError[m.key] !== undefined && <ErrorBox error={suggestError[m.key] ?? null} />}
                      {(suggested[m.key]?.ambiguities.length ?? 0) > 0 && (
                        <div className="space-y-2 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-3 text-xs">
                          <p className="font-semibold text-slate-800">These words cannot be checked as written</p>
                          <ul className="space-y-1.5 text-slate-700">
                            {suggested[m.key]?.ambiguities.map((a) => (
                              <li key={`${a.term}:${a.excerpt}`}>
                                <strong>“{a.term}”:</strong> {a.problem} Try: {a.alternatives.join("; ")}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(suggested[m.key]?.notes ?? "") !== "" && <p className="whitespace-pre-line rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{suggested[m.key]?.notes}</p>}
                      {/* The weight bar, for both views: full and teal at exactly 100%, amber otherwise. */}
                      <div role="meter" aria-label="Weights" aria-valuemin={0} aria-valuemax={100} aria-valuenow={weightSum / 100} className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div className={cn("h-full transition-[width]", weightSum === 10_000 ? "bg-primary" : "bg-amber-500")} style={{ width: `${String(Math.min(100, weightSum / 100))}%` }} />
                      </div>
                      <p className="text-xs text-slate-500">
                        Each criterion pays its weight when it is met. Weights must add up to 100%.{" "}
                        <span className={weightSum === 10_000 ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
                          Now {formatWeight(weightSum)}%.
                        </span>{" "}
                        <button
                          type="button"
                          className="text-primary underline underline-offset-2"
                          onClick={() => {
                            const even = evenWeights(m.criteria.length);
                            setMilestone(m.key, { criteria: m.criteria.map((c, j) => ({ ...c, origin: originAfterEdit(c.origin), rationale: undefined, weight: formatWeight(even[j] ?? 0) })) });
                          }}
                        >
                          Split evenly
                        </button>
                      </p>
                      {/* ADR-0022, view 2: the same criteria as a grid. Both views edit the same state through
                          setCriterion, so switching never loses anything and the submit is the same. */}
                      {criteriaView === "table" && !narrow ? (
                        <CriteriaGridLoader
                          criteria={m.criteria}
                          codes={codes}
                          registerFlush={(flush) => {
                            if (flush === null) gridFlushes.current.delete(m.key);
                            else gridFlushes.current.set(m.key, flush);
                          }}
                          onChange={(ck, patch) => { setCriterion(m.key, ck, patch); }}
                          onRemove={m.criteria.length > 1 ? (ck) => { setMilestone(m.key, { criteria: m.criteria.filter((x) => x.key !== ck) }); } : null}
                        />
                      ) : (
                        m.criteria.map((c, ci) => (
                        <div key={c.key} className="space-y-3 rounded-lg border border-slate-200 p-3">
                          <div className="flex items-start gap-2">
                            <span className="mt-2 shrink-0 font-mono text-xs font-bold whitespace-nowrap text-slate-400" title="Criterion code. It changes while the draft is edited.">{codes.get(c.key) ?? `${String(ci + 1)}.`}</span>
                            <Input required maxLength={500} placeholder="The landing page returns 200 at /" value={c.text} onChange={(e) => { setCriterion(m.key, c.key, { text: e.target.value }); }} />
                          </div>
                          {c.rationale !== undefined && c.rationale !== "" && <p className="text-xs text-slate-500">Why: {c.rationale}</p>}
                          <div role="radiogroup" aria-label="How it is verified" className="grid gap-2 sm:grid-cols-3">
                            {LEVELS.map((l) => (
                              <button
                                key={l.level}
                                type="button"
                                role="radio"
                                aria-checked={c.level === l.level}
                                onClick={() => { setCriterion(m.key, c.key, { level: l.level, checkType: l.defaultCheck }); }}
                                className={cn(
                                  "rounded-lg border p-2 text-left text-xs transition-colors",
                                  c.level === l.level ? "border-primary bg-accent-soft ring-1 ring-primary" : "border-slate-200 hover:border-slate-400",
                                )}
                              >
                                <span className="block text-sm font-bold">{l.label}</span>
                                <span className="text-slate-500">{l.hint}</span>
                              </button>
                            ))}
                          </div>
                          {c.level !== "HUMAN" && (
                            <div className="grid gap-2 sm:grid-cols-2">
                              <Select
                                aria-label="Check"
                                value={c.checkType}
                                onChange={(e) => { setCriterion(m.key, c.key, { checkType: e.target.value as CheckType }); }}
                              >
                                {CHECK_TYPES.filter((t) => t.level === c.level && (t.unavailable !== true || t.value === c.checkType)).map((t) => (
                                  <option key={t.value} value={t.value}>
                                    {t.label}
                                  </option>
                                ))}
                              </Select>
                              {c.level === "AI_EVALUATED" && (
                                <Input type="url" aria-label="Page to read" placeholder="https://… (empty: the link in the delivery)" value={c.probeUrl} onChange={(e) => { setCriterion(m.key, c.key, { probeUrl: e.target.value }); }} />
                              )}
                              {c.level === "AI_EVALUATED" && (
                                <Textarea
                                  required
                                  minLength={10}
                                  maxLength={2000}
                                  aria-label="What the AI should look for"
                                  placeholder="What must be there for this to be met, e.g. The page lists the Basic, Pro and Team plans with their prices"
                                  className="min-h-16 sm:col-span-2"
                                  value={c.guidance}
                                  onChange={(e) => { setCriterion(m.key, c.key, { guidance: e.target.value }); }}
                                />
                              )}
                              {c.checkType === "HTTP_PROBE" && (
                                <Input type="url" required placeholder="https://example.com/health" value={c.probeUrl} onChange={(e) => { setCriterion(m.key, c.key, { probeUrl: e.target.value }); }} />
                              )}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
                            <label className="flex items-center gap-2">
                              Weight
                              <Input
                                className="w-20"
                                inputMode="decimal"
                                required
                                value={c.weight}
                                aria-invalid={c.weight !== "" && weights[ci]?.ok === false}
                                onChange={(e) => { setCriterion(m.key, c.key, { weight: e.target.value }); }}
                              />
                              %
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={c.required} onChange={(e) => { setCriterion(m.key, c.key, { required: e.target.checked }); }} />
                              Required before anything is paid
                            </label>
                            {m.criteria.length > 1 && (
                              <Button type="button" variant="ghost" size="sm" onClick={() => { setMilestone(m.key, { criteria: m.criteria.filter((x) => x.key !== c.key) }); }}>
                                Remove
                              </Button>
                            )}
                          </div>
                        </div>
                      ))
                      )}
                      <Button type="button" variant="outline" size="sm" onClick={() => { setMilestone(m.key, { criteria: [...m.criteria, blankCriterion()] }); }}>
                        + Add criterion
                      </Button>
                    </fieldset>
                  </div>
                </div>
              );
            })}
            <Button type="button" variant="outline" className="w-full border-dashed" onClick={() => { setForm({ ...form, milestones: [...form.milestones, blankMilestone()] }); }}>
              + Add milestone
            </Button>
          </div>
        </Card>

        <Card className="p-6">
          <SectionTitle n={3} title="Terms" hint="What happens after the work is verified." />
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <Label>Release countdown</Label>
              <p className="text-slate-500">After verification, the buyer has this long to object before any payment is released. It is never zero.</p>
              <div className="flex flex-wrap gap-2">
                {COUNTDOWN_PRESETS.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant={form.terms.releaseCountdownSeconds === s ? "default" : "outline"}
                    onClick={() => { setForm({ ...form, terms: { ...form.terms, releaseCountdownSeconds: s } }); }}
                  >
                    {formatCountdown(s)}
                  </Button>
                ))}
              </div>
            </div>
            {/* Fixed in the MVP (draft-input.ts: literals), so shown as facts, not inputs. */}
            <ul className="space-y-1 rounded-lg bg-slate-50 p-3 text-slate-600">
              <li>• If the buyer does not answer before the window closes, the payment is released.</li>
              <li>• Each milestone is paid by the weight of the criteria that are met. Nothing is paid until every required one is met.</li>
              <li>• What is not met stays reserved in the buyer&apos;s PayPal until the seller fixes it, or goes back to the buyer.</li>
              <li>• Milestones are funded one at a time.</li>
            </ul>
          </div>
        </Card>

        {props.mode === "create" && (
          <Card className="p-6">
            <SectionTitle n={4} title="Who will do the work?" hint="You can also decide this on the contract page, after creating it." />
            <fieldset className="space-y-3 text-sm">
              <legend className="sr-only">Who will do the work?</legend>
              {WHO_OPTIONS.map(([value, title, body]) => (
                <label key={value} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3", who === value ? "border-primary bg-accent-soft/40" : "border-slate-200")}>
                  <input type="radio" name="who" value={value} checked={who === value} onChange={() => { setWho(value); }} className="mt-1" />
                  <span>
                    <span className="font-medium">{title}</span>
                    <span className="block text-slate-500">{body}</span>
                  </span>
                </label>
              ))}
              {who === "INVITE" && (
                <div className="space-y-1.5">
                  <Label htmlFor="invite-email">Seller&apos;s email</Label>
                  <Input id="invite-email" type="email" required placeholder="seller@example.com" value={inviteEmail} onChange={(e) => { setInviteEmail(e.target.value); }} />
                  <p className="text-xs text-slate-500">Use the address they will enter Settld with. The invitation only opens with that address.</p>
                </div>
              )}
            </fieldset>
          </Card>
        )}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6">
        <Card className="p-5">
          <h2 className="text-xs font-bold tracking-wider text-slate-500 uppercase">Summary</h2>
          <p className="mt-1 truncate font-bold">{form.title || "Untitled contract"}</p>
          <ol className="mt-4 space-y-2 text-sm">
            {form.milestones.map((m, i) => {
              const a = amounts[i];
              return (
                <li key={m.key} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <span className="mr-1.5 font-bold text-slate-400">{i + 1}</span>
                    {m.title || "Untitled milestone"}
                  </span>
                  <span className="shrink-0 font-mono">{a?.ok ? formatMoney({ amountMinor: a.amountMinor, currency: form.currency }) : "—"}</span>
                </li>
              );
            })}
          </ol>
          <div className="mt-4 flex items-baseline justify-between border-t border-slate-200 pt-3">
            <span className="font-bold">Total</span>
            <span className="font-mono text-xl font-bold">{formatMoney({ amountMinor: total, currency: form.currency })}</span>
          </div>
          {!allAmountsValid && <p className="mt-1 text-xs text-slate-500">Some amounts are missing or invalid.</p>}
          <p className="mt-4 text-xs text-slate-500">Nothing is charged now. Each milestone is reserved in your PayPal when you fund it, and paid only after its work is verified.</p>
          <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-4 w-full">
            {props.mode === "edit" ? "Save draft" : who === "INVITE" ? "Create and send invitation" : "Create contract"}
          </Button>
          <p className="mt-2 text-center text-xs text-slate-400">{props.mode === "create" ? "You can still edit it before sending it for approval." : props.supersedes ? `Creates version ${String(props.version + 1)}.` : `Saves over version ${String(props.version)}.`}</p>
          <ErrorBox error={error} />
        </Card>
      </aside>
    </form>
  );
}
