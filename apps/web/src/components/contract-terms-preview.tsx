import { Bot, CalendarDays, User, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Schemas } from "@/lib/api-types";
import { checkLabel } from "@/lib/copy";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { formatCountdown, formatWeight } from "@/lib/weights";

// What a seller reads before agreeing, whether invited or taking an open project.
export function ContractTermsPreview({ total, terms, milestones }: { total: Schemas["Money"]; terms: Schemas["Terms"]; milestones: Schemas["MilestoneInput"][] }) {
  const rows: [string, string][] = [
    ["Total", formatMoney(total)],
    ["Release countdown", formatCountdown(terms.releaseCountdownSeconds)],
    ["If the buyer does not answer", terms.silenceIsApproval ? "the countdown ends and the verified part is paid" : "nothing is paid until the buyer approves"],
    ["Funding", terms.fundingMode === "ONE_AT_A_TIME" ? "one milestone at a time" : "all milestones at once"],
  ];
  return (
    <>
      <Card>
        <CardContent className="grid gap-3 p-5 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label}>
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
              <p className="text-sm text-ink">{value}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {milestones.map((m, i) => (
        <Card key={m.id ?? i}>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-500">Milestone {i + 1}</p>
              <CardTitle>{m.title}</CardTitle>
              <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-500">
                <CalendarDays className="size-3.5" aria-hidden /> Due {formatDate(m.dueDate)}
              </p>
            </div>
            <p className="shrink-0 text-lg font-bold text-navy">{formatMoney(m.amount)}</p>
          </CardHeader>
          <CardContent>
            {m.description !== undefined && m.description !== "" && <p className="mb-3 text-sm whitespace-pre-line text-slate-600">{m.description}</p>}
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">You are paid for what passes</h3>
            <ul className="space-y-2 text-sm">
              {m.criteria.map((c, j) => (
                <li key={c.id ?? j} className="flex items-start gap-2.5">
                  <CriterionIcon level={c.level} />
                  <span className="min-w-0">
                    <span className="mr-1.5 text-xs font-medium text-slate-500">{c.level === "HUMAN" ? "Human review" : checkLabel(c.checkType ?? c.level)}</span>
                    <br />
                    {c.text}
                    <span className="text-slate-400"> · {formatWeight(c.weightBps)}%{c.required ? "" : ", optional"}</span>
                    {checkUrl(c.checkConfig) !== null && <span className="block truncate font-mono text-xs text-slate-500">{checkUrl(c.checkConfig)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

// HTTP_PROBE and similar checks name the address they hit; the seller should see it before agreeing.
function checkUrl(config: object | null | undefined): string | null {
  const url = (config as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" ? url : null;
}

const LEVEL_ICON = { AUTOMATIC: Zap, AI_EVALUATED: Bot, HUMAN: User } as const;

function CriterionIcon({ level }: { level: keyof typeof LEVEL_ICON }) {
  const Icon = LEVEL_ICON[level];
  return (
    <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", level === "HUMAN" ? "bg-amber-50 text-amber-600" : "bg-sky-50 text-sky-600")}>
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}
