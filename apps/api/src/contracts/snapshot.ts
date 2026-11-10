// The frozen content both parties approve (domain-model.md: ContractSnapshot; ADR-0004).
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { ProblemException } from "../errors/problem.js";
import type { DraftInput, ParsedDraft } from "./draft-input.js";

type Level = "AUTOMATIC" | "AI_EVALUATED" | "HUMAN";

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface SnapshotCriterion {
  readonly id: string;
  readonly text: string;
  readonly level: Level;
  readonly required: boolean;
  readonly weightBps: number;
  readonly checkType: string | null;
  readonly checkConfig: Record<string, unknown> | null;
  readonly origin: string;
  readonly aiSuggestionId: string | null;
}

export interface SnapshotMilestone {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly amount: Money;
  readonly dueDate: string;
  readonly criteria: readonly SnapshotCriterion[];
}

// ADR-0009: the seller (userId null until someone accepts the seller invitation) and the
// collaborators, with the share of every release each one gets.
export interface TeamMember {
  readonly userId: string | null;
  readonly role: string;
  readonly shareBps: number;
}

export const SELLER_ALONE: readonly TeamMember[] = [{ userId: null, role: "Seller", shareBps: 10_000 }];

// Versions written before ADR-0009 have no team: they mean the seller alone. Read, never rewritten,
// because the snapshot is hashed and frozen (DM-INV-2).
export function teamOf(snapshot: ContractSnapshot): readonly TeamMember[] {
  return snapshot.team ?? SELLER_ALONE;
}

export interface ContractSnapshot {
  readonly title: string;
  readonly description: string;
  readonly currency: string;
  readonly terms: {
    readonly releaseCountdownSeconds: number;
    readonly silenceIsApproval: true;
    readonly fundingMode: "ONE_AT_A_TIME" | "ALL_AT_ONCE";
    readonly platformFeeBps: number;
  };
  readonly milestones: readonly SnapshotMilestone[];
  readonly team?: readonly TeamMember[];
}

export interface BuildOptions {
  readonly platformFeeBps: number;
  readonly newId: () => string;
  // Ids already used by this contract. A caller may keep them (stable across versions)
  // but may not invent or borrow one: milestone ids are primary keys in core.milestones.
  readonly knownMilestoneIds: ReadonlySet<string>;
  readonly knownCriterionIds: ReadonlySet<string>;
}

// Turns validated input into a snapshot with every id assigned and every default explicit.
// Explicit defaults matter: the hash covers exactly what is stored, so "absent" and "default"
// must not produce two different hashes for the same agreement.
export function buildSnapshot(input: ParsedDraft | DraftInput, opts: BuildOptions): ContractSnapshot {
  const keep = (id: string | undefined, known: ReadonlySet<string>, path: string): string => {
    if (id === undefined) return opts.newId();
    if (!known.has(id)) {
      throw new ProblemException("VALIDATION_FAILED", 422, "Some fields need fixing", `Unknown id at ${path}`, {
        issues: [{ path, message: "Not an id of this contract; omit it to create a new item" }],
      });
    }
    return id;
  };

  return {
    title: input.title,
    description: input.description ?? "",
    currency: input.currency,
    terms: {
      releaseCountdownSeconds: input.terms.releaseCountdownSeconds ?? 172_800,
      silenceIsApproval: true,
      fundingMode: input.terms.fundingMode ?? "ONE_AT_A_TIME",
      platformFeeBps: opts.platformFeeBps,
    },
    milestones: input.milestones.map((m, i) => ({
      id: keep(m.id, opts.knownMilestoneIds, `milestones.${String(i)}.id`),
      title: m.title,
      description: m.description ?? "",
      amount: { amountMinor: m.amount.amountMinor, currency: m.amount.currency },
      dueDate: m.dueDate,
      criteria: m.criteria.map((c, j) => ({
        id: keep(c.id, opts.knownCriterionIds, `milestones.${String(i)}.criteria.${String(j)}.id`),
        text: c.text,
        level: c.level,
        required: c.required ?? true,
        weightBps: c.weightBps,
        checkType: c.checkType ?? null,
        checkConfig: c.checkConfig ?? null,
        origin: c.origin ?? "USER_WRITTEN",
        aiSuggestionId: c.aiSuggestionId ?? null,
      })),
    })),
    // Explicit even when omitted, like every other default: "absent" and "seller alone" must
    // hash the same agreement the same way.
    team: (input.team ?? SELLER_ALONE).map((t) => ({ userId: t.userId, role: t.role, shareBps: t.shareBps })),
  };
}

// sha256 over RFC 8785 canonical JSON. Canonical form makes the hash a property of the
// content, not of how a given serializer happened to order keys or format numbers, so the
// web app, the Engine or an auditor can recompute it and get the same value.
export function hashSnapshot(snapshot: unknown): string {
  const canonical = canonicalize(snapshot);
  if (canonical === undefined) throw new Error("Snapshot cannot be canonicalized");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

// G-MILESTONE-VALID (milestone-state-machine.md): amount > 0, due date in the future,
// at least one criterion, at least one required criterion, and weights that add up to
// exactly 100%. A sum below 10 000 would leave part of the money unreachable forever; above
// it, the release rule would promise more than was funded.
export function milestoneGuardFailures(snapshot: ContractSnapshot, today: string): { milestoneId: string; reason: string }[] {
  const failures: { milestoneId: string; reason: string }[] = [];
  for (const m of snapshot.milestones) {
    const reasons: string[] = [];
    if (m.amount.amountMinor <= 0) reasons.push("amount must be greater than zero");
    // ISO dates compare correctly as strings.
    if (m.dueDate <= today) reasons.push("due date must be in the future");
    if (m.criteria.length === 0) reasons.push("needs at least one criterion");
    else {
      if (!m.criteria.some((c) => c.required)) reasons.push("needs at least one required criterion");
      const weights = weightSum(m);
      if (weights !== 10_000) reasons.push(`criterion weights must add up to 100% (now ${(weights / 100).toFixed(2)}%)`);
    }
    if (reasons.length > 0) failures.push({ milestoneId: m.id, reason: reasons.join("; ") });
  }
  return failures;
}

// Sum of the criterion weights of one milestone. A criterion without a weight (a version
// agreed before ADR-0007) counts as 0, so such a milestone never passes the 100% rule.
export function weightSum(m: SnapshotMilestone): number {
  return m.criteria.reduce((sum, c) => sum + ((c.weightBps as number | undefined) ?? 0), 0);
}

export function verifiabilityScore(m: { readonly criteria: readonly { readonly level: string }[] }): number {
  if (m.criteria.length === 0) return 0;
  const verifiable = m.criteria.filter((c) => c.level !== "HUMAN").length;
  return verifiable / m.criteria.length;
}

export const LOW_VERIFIABILITY = 0.6;
