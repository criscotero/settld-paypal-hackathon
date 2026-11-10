import { BadgeCheck, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

// How a person looks to others: on a contract, in the directory, in the team table.
export function PersonCard({ name, headline, professions, skills, country, paypal, compact = false }: { name: string; headline: string; professions: string[]; skills: string[]; country?: string; paypal: boolean; compact?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-primary">{initials(name || "?")}</span>
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-1.5 font-semibold">
          {name}
          {paypal && <BadgeCheck className="size-4 text-primary" aria-label="PayPal connected" />}
          {country && (
            <span className="flex items-center gap-0.5 text-xs font-normal text-slate-400">
              <Globe className="size-3" aria-hidden /> {country}
            </span>
          )}
        </p>
        {headline !== "" && <p className="text-sm text-slate-600">{headline}</p>}
        {!compact && (
          <div className="flex flex-wrap gap-1 pt-1">
            {professions.map((p) => (
              <Badge key={p} tone="info">
                {p}
              </Badge>
            ))}
            {skills.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
