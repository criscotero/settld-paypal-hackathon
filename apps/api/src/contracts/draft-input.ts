// openapi.yaml: ContractDraftInput, MilestoneInput, CriterionInput, Terms, Money.
// Hand-written while codegen (0.6) is postponed; keep it in sync with the contract.
import { z } from "zod";

const CHECK_TYPES = ["GITHUB_PR_MERGED", "CI_STATUS_GREEN", "TESTS_PASSED", "HTTP_PROBE", "AI_FEATURE_PRESENT", "AI_REQUIREMENT_MET"] as const;
const currency = z.string().regex(/^[A-Z]{3}$/);

const money = z.strictObject({
  // Integer minor units, never floats (contracts README). Safe-integer bound keeps JS exact.
  amountMinor: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency,
});

const AI_CHECK_TYPES: readonly string[] = ["AI_FEATURE_PRESENT", "AI_REQUIREMENT_MET"];

// schemas/checks/ai-check.v2.json, a superset of v1 (ADR-0019). Validated when saving because
// this is what both parties approve: a bad config would otherwise surface after the money is
// reserved, as a check that can never run.
const aiCheckConfig = z.strictObject({
  sources: z
    .array(z.enum(["DIFF", "SCREENSHOT", "HTTP_RESPONSE", "TEST_REPORT", "NOTES", "REPOSITORY", "FILES"]))
    .min(1)
    .refine((s) => new Set(s).size === s.length, { message: "Each source can appear only once" }),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).nullish(),
  url: z.url({ protocol: /^https$/ }).nullish(),
  guidance: z.string().min(10).max(2000),
});

const criterion = z
  .object({
    id: z.uuid().optional(),
    text: z.string().min(1).max(500),
    level: z.enum(["AUTOMATIC", "AI_EVALUATED", "HUMAN"]),
    required: z.boolean().default(true),
    // Basis points of the milestone amount (ADR-0007). The per-milestone sum of 10 000 is
    // G-MILESTONE-VALID, checked at submit and lock, not here: a draft may be half written.
    weightBps: z.int().min(1).max(10_000),
    checkType: z.enum(CHECK_TYPES).nullish(),
    checkConfig: z.record(z.string(), z.unknown()).nullish(),
    origin: z.enum(["AI_SUGGESTED", "USER_WRITTEN", "AI_SUGGESTED_EDITED"]).default("USER_WRITTEN"),
    aiSuggestionId: z.uuid().nullish(),
  })
  // domain-model.md: checkType is required when the level is AUTOMATIC or AI_EVALUATED.
  .refine((c) => c.level === "HUMAN" || c.checkType != null, {
    message: "checkType is required for AUTOMATIC and AI_EVALUATED criteria",
    path: ["checkType"],
  })
  // An AUTOMATIC criterion counts toward a release by itself (countedCriteria). An AI check under
  // that level would let a model move money, which constitution VI forbids.
  .refine((c) => !AI_CHECK_TYPES.includes(c.checkType ?? "") || c.level === "AI_EVALUATED", {
    message: "An AI check must have level AI_EVALUATED",
    path: ["level"],
  })
  .superRefine((c, ctx) => {
    if (!AI_CHECK_TYPES.includes(c.checkType ?? "")) return;
    const config = aiCheckConfig.safeParse(c.checkConfig);
    if (!config.success) {
      for (const issue of config.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: ["checkConfig", ...issue.path] });
    }
  });

const milestone = z.object({
  id: z.uuid().optional(),
  title: z.string().min(1).max(140),
  description: z.string().max(5000).default(""),
  amount: money,
  dueDate: z.iso.date(),
  criteria: z.array(criterion),
});

const terms = z.object({
  // Constitution XII and D6: the countdown before money moves is a term and never zero.
  releaseCountdownSeconds: z.int().min(60).max(604_800).default(172_800),
  // MVP fixed true (Q-SM-2).
  silenceIsApproval: z.literal(true).default(true),
  fundingMode: z.enum(["ONE_AT_A_TIME", "ALL_AT_ONCE"]).default("ONE_AT_A_TIME"),
  // platformFeeBps is readOnly: whatever the client sends is ignored (stripped).
});

// ADR-0009. Who may be in it (collaborator parties of the contract) is checked by the service,
// which can see the contract; the shape is checked here.
const team = z
  .array(z.object({ userId: z.uuid().nullable(), role: z.string().trim().min(1).max(60), shareBps: z.int().min(1).max(10_000) }))
  .min(1)
  .max(5)
  .superRefine((t, ctx) => {
    if (t.filter((m) => m.userId === null).length !== 1) ctx.addIssue({ code: "custom", message: "Exactly one entry is the seller (userId null)", path: [] });
    const ids = t.flatMap((m) => (m.userId === null ? [] : [m.userId]));
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "A person appears twice", path: [] });
    const sum = t.reduce((a, m) => a + m.shareBps, 0);
    if (sum !== 10_000) ctx.addIssue({ code: "custom", message: `Shares must add up to 100% (now ${(sum / 100).toFixed(2)}%)`, path: [] });
  });

const draftInput = z
  .object({
    title: z.string().min(1).max(140),
    description: z.string().max(5000).default(""),
    currency,
    terms,
    milestones: z.array(milestone),
    team: team.optional(),
  })
  .superRefine((d, ctx) => {
    // DM-INV-1: every amount in a contract uses the contract currency.
    d.milestones.forEach((m, i) => {
      if (m.amount.currency !== d.currency) {
        ctx.addIssue({
          code: "custom",
          message: `Milestone currency must be ${d.currency}`,
          path: ["milestones", i, "amount", "currency"],
        });
      }
    });
  });

export type DraftInput = z.input<typeof draftInput>;
export type ParsedDraft = z.output<typeof draftInput>;

export function parseDraftInput(body: unknown) {
  return draftInput.safeParse(body);
}
