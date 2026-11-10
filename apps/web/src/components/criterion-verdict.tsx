// A criterion's verdict and why. Reasons and excerpts can quote the seller's content, so they are
// only ever rendered as text, and an excerpt is labeled as coming from the evidence.
import { CircleCheck, CircleHelp, CircleX, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { checkLines, checksSummary, verdictView } from "@/lib/verdict";
import type { CheckTone, CriterionResult, VerdictTone } from "@/lib/verdict";

const TONE: Record<VerdictTone, string> = {
  good: "bg-emerald-50 text-emerald-800",
  bad: "bg-red-50 text-red-800",
  neutral: "bg-slate-100 text-slate-700",
  warning: "bg-amber-100 text-amber-900",
};

const CHECK_ICON: Record<CheckTone, { Icon: typeof CircleCheck; className: string }> = {
  met: { Icon: CircleCheck, className: "text-emerald-700" },
  "not-met": { Icon: CircleX, className: "text-red-700" },
  unsure: { Icon: CircleHelp, className: "text-slate-500" },
};

export function CriterionVerdict({ result }: { result: CriterionResult }) {
  const view = verdictView(result);
  const lines = checkLines(result);
  const summary = checksSummary(lines);
  return (
    <div className="mt-1 space-y-1">
      <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-semibold", TONE[view.tone])}>{view.label}</span>
      {result.reason !== "" && <p className="text-xs whitespace-pre-line text-slate-600">{result.reason}</p>}
      {view.note !== null && <p className="text-xs text-slate-500">{view.note}</p>}
      {summary !== null && (
        <details className="rounded border border-slate-200 p-1.5 text-xs">
          <summary className="cursor-pointer font-medium text-slate-700">{summary}: what the verifier checked</summary>
          <ul className="mt-1.5 space-y-1.5">
            {lines.map((line, i) => {
              const { Icon, className } = CHECK_ICON[line.tone];
              return (
                <li key={`${String(i)}-${line.requirement}`} className="flex items-start gap-1.5">
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", className)} aria-hidden />
                  <div className="min-w-0 break-words text-slate-600">
                    <p>
                      <span className="font-semibold">{line.label}:</span> {line.requirement}
                    </p>
                    <p className="text-slate-500">{line.finding}</p>
                    {line.fix !== null && <p className="text-slate-700">To fix: {line.fix}</p>}
                    {line.note !== null && <p className="text-slate-500">{line.note}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {(result.injectionFlags ?? []).map((flag) => (
        <p key={`${flag.evidenceSnapshotId}-${flag.kind}-${flag.excerpt}`} className="flex items-start gap-1.5 rounded bg-amber-50 p-1.5 text-xs text-amber-900">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">Found in the evidence: “{flag.excerpt}”</span>
        </p>
      ))}
    </div>
  );
}
