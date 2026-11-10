"use client";
// The professional profile (ADR-0009): what a seller or collaborator does, and whether they can
// be found in the directory. Controlled, so the onboarding step and /profile share it.
import { Check, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import type { Schemas } from "@/lib/api-types";
import { PROFESSION_LABELS, PROFESSIONS } from "@/lib/professions";
import { cn } from "@/lib/utils";

export type Professional = Schemas["ProfessionalProfile"];

export function ProfessionalFields({ value, onChange }: { value: Professional; onChange: (v: Professional) => void }) {
  const [skill, setSkill] = useState("");
  const set = (patch: Partial<Professional>) => {
    onChange({ ...value, ...patch });
  };
  const addSkill = () => {
    const s = skill.trim();
    if (s !== "" && s.length <= 40 && !value.skills.includes(s) && value.skills.length < 12) set({ skills: [...value.skills, s] });
    setSkill("");
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="headline">Headline</Label>
        <Input id="headline" maxLength={80} placeholder="Full-stack developer · Next.js and payments" value={value.headline ?? ""} onChange={(e) => { set({ headline: e.target.value === "" ? null : e.target.value }); }} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">What you do · up to 5</legend>
        <div className="flex flex-wrap gap-2">
          {PROFESSIONS.map((p) => {
            const on = value.professions.includes(p);
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                disabled={!on && value.professions.length >= 5}
                onClick={() => { set({ professions: on ? value.professions.filter((x) => x !== p) : [...value.professions, p] }); }}
                className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-40", on ? "border-primary bg-accent-soft text-primary" : "border-slate-300 hover:border-slate-400")}
              >
                {on && <Check className="size-3.5" aria-hidden />}
                {PROFESSION_LABELS[p]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="skill">Services and skills · up to 12</Label>
        <div className="flex gap-2">
          <Input
            id="skill"
            value={skill}
            maxLength={40}
            placeholder="Figma, Playwright, dbt…"
            onChange={(e) => { setSkill(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSkill();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addSkill}>
            Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {value.skills.map((s) => (
            <span key={s} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2.5 text-sm">
              {s}
              <button type="button" aria-label={`Remove ${s}`} className="rounded-full p-0.5 hover:bg-slate-200" onClick={() => { set({ skills: value.skills.filter((x) => x !== s) }); }}>
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bio">Short bio</Label>
        <Textarea id="bio" maxLength={400} className="min-h-16" value={value.bio ?? ""} onChange={(e) => { set({ bio: e.target.value === "" ? null : e.target.value }); }} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="link">Portfolio, GitHub or LinkedIn</Label>
        <Input id="link" type="url" pattern="https://.*" placeholder="https://" value={value.link ?? ""} onChange={(e) => { set({ link: e.target.value === "" ? null : e.target.value }); }} />
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm">
        <input type="checkbox" className="mt-1" checked={value.inDirectory} onChange={(e) => { set({ inDirectory: e.target.checked }); }} />
        <span>
          <span className="font-medium">Appear in the Settld directory</span>
          <span className="block text-slate-500">Sellers can find you by what you do and add you to their teams. Your email is never shown. Off: nobody can find you.</span>
        </span>
      </label>
    </div>
  );
}

export const EMPTY_PROFESSIONAL: Professional = { headline: null, professions: [], skills: [], bio: null, link: null, inDirectory: false };
