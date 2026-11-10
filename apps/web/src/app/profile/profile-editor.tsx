"use client";
import { useState, useTransition } from "react";
import { saveProfessional } from "@/app/onboarding/actions";
import { ErrorBox } from "@/components/error-box";
import { EMPTY_PROFESSIONAL, ProfessionalFields } from "@/components/professional-fields";
import type { Professional } from "@/components/professional-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Schemas } from "@/lib/api-types";
import type { ActionError } from "@/lib/problem";
import { PROFESSION_LABELS } from "@/lib/professions";

export function ProfileEditor({ me }: { me: Schemas["User"] }) {
  const [value, setValue] = useState<Professional>(me.professional ?? EMPTY_PROFESSIONAL);
  const [error, setError] = useState<ActionError | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const paid = me.roles.includes("SELLER") || me.roles.includes("COLLABORATOR");

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
      <Card className="space-y-5 p-6">
        <div>
          <h1 className="text-xl font-bold">What you do</h1>
          <p className="text-sm text-slate-500">{paid ? "Shown on your contracts and, if you opt in, in the directory." : "For sellers and collaborators. As a buyer you can fill it in, but nobody searches for buyers."}</p>
        </div>
        <ProfessionalFields value={value} onChange={(v) => { setValue(v); setSaved(false); }} />
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            loading={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const r = await saveProfessional(value);
                setError(r);
                setSaved(r === null);
              });
            }}
          >
            Save
          </Button>
          {saved && <span role="status" className="text-sm text-emerald-700">Saved.</span>}
        </div>
        <ErrorBox error={error} />
      </Card>
      <aside className="space-y-3 lg:sticky lg:top-24">
        <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">How others see you</p>
        <Card className="space-y-2 p-5">
          <p className="font-semibold">{me.displayName}</p>
          <p className="text-sm text-slate-600">{value.headline ?? "No headline yet"}</p>
          <div className="flex flex-wrap gap-1">
            {value.professions.map((p) => (
              <Badge key={p} tone="info">
                {PROFESSION_LABELS[p]}
              </Badge>
            ))}
            {value.skills.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </div>
          <p className="border-t border-slate-100 pt-2 text-xs text-slate-500">{value.inDirectory ? "Listed in the directory." : "Not listed in the directory."}</p>
        </Card>
      </aside>
    </div>
  );
}
