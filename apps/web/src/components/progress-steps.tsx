import type { Step, StepStatus } from "@/lib/progress";
import { cn } from "@/lib/utils";

const DOT: Record<StepStatus, string> = {
  done: "border-emerald-600 bg-emerald-600 text-white",
  current: "border-primary bg-white text-primary ring-4 ring-accent-soft",
  upcoming: "border-slate-300 bg-white text-slate-400",
  problem: "border-amber-500 bg-amber-400 text-ink ring-4 ring-amber-100",
  cancelled: "border-slate-300 bg-slate-200 text-slate-500",
};

const MARK: Record<StepStatus, string> = { done: "✓", current: "", upcoming: "", problem: "!", cancelled: "✕" };

const CAPTION: Record<StepStatus, string> = {
  done: "Completed",
  current: "In progress",
  upcoming: "Upcoming",
  problem: "Needs attention",
  cancelled: "Cancelled",
};

// Horizontal progress bar of a parcel tracking page: one dot per step, the line
// filled in red up to the furthest step that is done or current. Vertical on phones.
export function ProgressSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-4 sm:flex-row sm:gap-0">
      {steps.map((s, i) => {
        const reached = s.status !== "upcoming";
        const nextReached = steps[i + 1] !== undefined && steps[i + 1]?.status !== "upcoming";
        return (
          <li key={s.id} className="relative flex items-center gap-3 sm:flex-1 sm:flex-col sm:items-center sm:gap-2 sm:text-center">
            {i < steps.length - 1 && (
              <span aria-hidden className={cn("absolute top-4 left-1/2 hidden h-1 w-full sm:block", nextReached ? "bg-emerald-600" : "bg-slate-200")} />
            )}
            <a
              href={s.id === "agreement" ? "#agreement" : `#milestone-${s.id}`}
              className={cn("relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold", DOT[s.status])}
              aria-label={`${s.title}: ${CAPTION[s.status]}`}
            >
              {MARK[s.status] || (s.status === "current" ? <span className="size-3 rounded-full bg-primary" /> : i)}
            </a>
            <div className="min-w-0 sm:px-2">
              <p className={cn("truncate text-sm font-bold", !reached && "text-slate-400")}>{s.title}</p>
              <p className={cn("text-xs", s.status === "problem" ? "font-semibold text-amber-700" : "text-slate-500")}>{CAPTION[s.status]}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
