import { eventText } from "@/lib/copy";
import type { Milestone } from "@/lib/api-types";
import { milestoneHistory } from "@/lib/progress";
import { cn } from "@/lib/utils";

// The "shipment history" list: newest reached event on top, upcoming ones greyed
// below it so you can see what is left.
export function MilestoneHistory({ state }: { state: Milestone["state"] }) {
  const entries = milestoneHistory(state);
  const reached = entries.filter((e) => e.status !== "upcoming").reverse();
  const upcoming = entries.filter((e) => e.status === "upcoming");
  return (
    <ol className="relative border-l-2 border-slate-200 pl-5">
      {[...reached, ...upcoming].map((e, i) => {
        const latest = i === 0 && e.status !== "upcoming";
        return (
          <li key={e.state} className="relative pb-4 last:pb-0">
            <span
              aria-hidden
              className={cn(
                "absolute top-1 -left-[27px] size-3 rounded-full border-2 border-white",
                e.status === "upcoming" && "bg-slate-300",
                e.status === "done" && "bg-emerald-600",
                e.status === "current" && "bg-accent ring-2 ring-primary",
                e.status === "problem" && "bg-amber-400 ring-2 ring-amber-600",
                e.status === "cancelled" && "bg-slate-500",
              )}
            />
            <p className={cn("text-sm", latest ? "font-bold" : e.status === "upcoming" ? "text-slate-400" : "text-slate-700")}>{eventText(e.state)}</p>
          </li>
        );
      })}
    </ol>
  );
}
