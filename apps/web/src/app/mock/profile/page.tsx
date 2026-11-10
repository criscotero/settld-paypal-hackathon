"use client";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PROFESSIONS } from "../mock-data";
import { PersonCard } from "@/components/person-card";
import { useMock } from "../store";

// The "About you" onboarding step, extended for sellers: what they do and whether they can
// be found. A new contract field set (User.profile) in the real app: docs/contracts first.
export default function ProfileMock() {
  const { state, set } = useMock();
  const p = state.profile;
  const [skill, setSkill] = useState("");
  const update = (patch: Partial<typeof p>) => {
    set((s) => ({ ...s, profile: { ...s.profile, ...patch } }));
  };
  const toggle = (prof: string) => {
    update({ professions: p.professions.includes(prof) ? p.professions.filter((x) => x !== prof) : [...p.professions, prof] });
  };
  const addSkill = () => {
    const v = skill.trim();
    if (v !== "" && !p.skills.includes(v) && p.skills.length < 12) update({ skills: [...p.skills, v] });
    setSkill("");
  };
  const ready = p.name.trim() !== "" && p.headline.trim() !== "" && p.professions.length > 0;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
      <Card className="space-y-5 p-6">
        <div>
          <p className="text-xs font-bold text-primary">Onboarding · step 2 of 4 · seller</p>
          <h1 className="mt-1 text-xl font-bold">What do you do?</h1>
          <p className="text-sm text-slate-500">Buyers and teammates see this on your contracts. Keep it short and specific.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Display name</Label>
            <Input id="name" value={p.name} maxLength={60} onChange={(e) => { update({ name: e.target.value }); }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="headline">Headline</Label>
            <Input id="headline" value={p.headline} maxLength={80} placeholder="Full-stack developer · Next.js and payments" onChange={(e) => { update({ headline: e.target.value }); }} />
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Professions · pick one or more</legend>
          <div className="flex flex-wrap gap-2">
            {PROFESSIONS.map((prof) => {
              const on = p.professions.includes(prof);
              return (
                <button
                  key={prof}
                  type="button"
                  aria-pressed={on}
                  onClick={() => { toggle(prof); }}
                  className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors", on ? "border-primary bg-accent-soft text-primary" : "border-slate-300 hover:border-slate-400")}
                >
                  {on && <Check className="size-3.5" aria-hidden />}
                  {prof}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="skill">Services and skills</Label>
          <div className="flex gap-2">
            <Input
              id="skill"
              value={skill}
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
            {p.skills.map((s) => (
              <span key={s} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2.5 text-sm">
                {s}
                <button type="button" aria-label={`Remove ${s}`} className="rounded-full p-0.5 hover:bg-slate-200" onClick={() => { update({ skills: p.skills.filter((x) => x !== s) }); }}>
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="bio">Short bio</Label>
            <Textarea id="bio" value={p.bio} maxLength={400} className="min-h-16" onChange={(e) => { update({ bio: e.target.value }); }} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="link">Portfolio, GitHub or LinkedIn</Label>
            <Input id="link" type="url" value={p.link} placeholder="https://" onChange={(e) => { update({ link: e.target.value }); }} />
          </div>
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={p.inDirectory} onChange={(e) => { update({ inDirectory: e.target.checked }); }} />
          <span>
            <span className="font-medium">Appear in the Settld directory</span>
            <span className="block text-slate-500">Other sellers can find you by profession and invite you to their teams. Off: only someone who knows your email can invite you.</span>
          </span>
        </label>

        <Link href="/mock/team" aria-disabled={!ready} className={cn(buttonVariants({ variant: "primary" }), !ready && "pointer-events-none opacity-60")}>
          Continue
        </Link>
        {!ready && <p className="text-xs text-slate-500">Add a name, a headline and at least one profession.</p>}
      </Card>

      <aside className="space-y-3 lg:sticky lg:top-24">
        <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">How others see you</p>
        <Card className="space-y-3 p-5">
          <PersonCard name={p.name || "Your name"} headline={p.headline || "Your headline"} professions={p.professions} skills={p.skills} paypal />
          {p.bio && <p className="text-sm text-slate-600">{p.bio}</p>}
          {p.link && <p className="truncate text-sm text-primary">{p.link}</p>}
          <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">{p.inDirectory ? "Listed in the directory." : "Not listed. Invitations by email only."}</p>
        </Card>
      </aside>
    </div>
  );
}
