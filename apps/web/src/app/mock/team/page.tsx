"use client";
// The seller builds the team: find people in the directory (opt-in only, constitution XI),
// give each a role and a share, and send it to the buyer, who approves it with the contract
// version (nobody pays against terms they did not see). Decisions a, b, c of the proposal.
import { CheckCircle2, Search, Trash2, UserPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
import { splitLargestRemainder } from "@/lib/split";
import { cn } from "@/lib/utils";
import { formatWeight, parseWeightPercent } from "@/lib/weights";
import { DIRECTORY, MILESTONE, PROFESSIONS } from "../mock-data";
import { PersonCard } from "@/components/person-card";
import { useMock } from "../store";
import type { TeamMember } from "../store";

const SWATCH = ["bg-primary", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-lime-500"];

export default function TeamMock() {
  const { state, set } = useMock();
  const [query, setQuery] = useState("");
  const [profession, setProfession] = useState("");
  const team = state.team;
  const sum = team.reduce((a, m) => a + m.shareBps, 0);
  const inTeam = new Set(team.map((m) => m.personId));

  const results = DIRECTORY.filter((p) => p.inDirectory && !inTeam.has(p.id))
    .filter((p) => profession === "" || p.professions.includes(profession))
    .filter((p) => {
      const q = query.trim().toLowerCase();
      return q === "" || [p.name, p.headline, ...p.skills].some((x) => x.toLowerCase().includes(q));
    });

  const setTeam = (next: TeamMember[]) => {
    // Any change to the team is a new version: the buyer has to approve it again.
    set((s) => ({ ...s, team: next, teamApproved: false }));
  };
  const invite = (personId: string) => {
    const person = DIRECTORY.find((p) => p.id === personId);
    setTeam([...team, { personId, role: person?.professions[0] ?? "Collaborator", shareBps: 1_000, status: "INVITED" }]);
  };
  const patch = (personId: string, change: Partial<TeamMember>) => {
    setTeam(team.map((m) => (m.personId === personId ? { ...m, ...change } : m)));
  };

  // A preview of the first release of the live contract (90% of USD 2,000).
  const example = 180_000;
  const parts = splitLargestRemainder(example, team.map((m) => m.shareBps));

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_24rem]">
      <div className="space-y-6">
        <Card className="space-y-4 p-6">
          <div>
            <h1 className="text-xl font-bold">Team for “{MILESTONE.contract}”</h1>
            <p className="text-sm text-slate-500">Each release is split by these shares, and PayPal pays each person directly. Settld never holds the money.</p>
          </div>

          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Person</th>
                  <th className="p-3 font-medium">Role in this project</th>
                  <th className="w-28 p-3 font-medium">Share</th>
                  <th className="w-10 p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {team.map((m, i) => {
                  const person = m.personId === "me" ? null : DIRECTORY.find((p) => p.id === m.personId);
                  const name = person?.name ?? state.profile.name;
                  return (
                    <tr key={m.personId}>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", SWATCH[i % SWATCH.length])} />
                          <span className="font-medium">{name}</span>
                          {m.personId === "me" ? <Badge tone="good">Seller</Badge> : <Badge tone={m.status === "ACCEPTED" ? "good" : "warn"}>{m.status === "ACCEPTED" ? "Joined" : "Invited"}</Badge>}
                        </div>
                      </td>
                      <td className="p-3">
                        <Input aria-label={`Role of ${name}`} value={m.role} maxLength={60} onChange={(e) => { patch(m.personId, { role: e.target.value }); }} />
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1">
                          <Input
                            aria-label={`Share of ${name}`}
                            inputMode="decimal"
                            defaultValue={formatWeight(m.shareBps)}
                            onBlur={(e) => {
                              const w = parseWeightPercent(e.target.value);
                              if (w.ok) patch(m.personId, { shareBps: w.bps });
                              else e.target.value = formatWeight(m.shareBps);
                            }}
                          />
                          %
                        </div>
                      </td>
                      <td className="p-3">
                        {m.personId !== "me" && (
                          <Button variant="ghost" size="sm" aria-label={`Remove ${name}`} onClick={() => { setTeam(team.filter((x) => x.personId !== m.personId)); }}>
                            <Trash2 aria-hidden />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5">
            <div className="flex h-3 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`Shares add up to ${formatWeight(sum)}%`}>
              {team.map((m, i) => (
                <span key={m.personId} className={SWATCH[i % SWATCH.length]} style={{ width: `${String(Math.min(100, m.shareBps / 100))}%` }} />
              ))}
            </div>
            <p className={cn("text-sm font-semibold", sum === 10_000 ? "text-emerald-700" : "text-amber-700")}>
              {sum === 10_000 ? "Shares add up to 100%." : `Shares add up to ${formatWeight(sum)}%. They must add up to exactly 100%.`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              disabled={sum !== 10_000 || state.teamApproved}
              onClick={() => {
                // In the real flow: a new contract version, approved by both by its hash.
                set((s) => ({ ...s, teamApproved: true, team: s.team.map((m) => ({ ...m, status: "ACCEPTED" })) }));
              }}
            >
              {state.teamApproved ? "Approved by the buyer" : "Send to the buyer for approval"}
            </Button>
            {state.teamApproved && (
              <>
                <span className="flex items-center gap-1 text-sm text-emerald-700">
                  <CheckCircle2 className="size-4" aria-hidden /> Collaborators accepted and the buyer approved version 2.
                </span>
                <Link href="/mock/contract" className={buttonVariants({ variant: "outline" })}>
                  Go to the live contract
                </Link>
              </>
            )}
          </div>
        </Card>

        <Card className="space-y-4 p-6">
          <div>
            <h2 className="font-semibold">Find collaborators</h2>
            <p className="text-sm text-slate-500">Only people who chose to appear in the directory. Anyone else: invite by exact email.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
            <div className="relative">
              <Search className="absolute top-2.5 left-3 size-4 text-slate-400" aria-hidden />
              <Input className="pl-9" aria-label="Search" placeholder="Name, skill or headline" value={query} onChange={(e) => { setQuery(e.target.value); }} />
            </div>
            <Select aria-label="Profession" value={profession} onChange={(e) => { setProfession(e.target.value); }}>
              <option value="">All professions</option>
              {PROFESSIONS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          </div>
          <ul className="divide-y divide-slate-100">
            {results.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <PersonCard name={p.name} headline={p.headline} professions={p.professions} skills={p.skills} country={p.country} paypal={p.paypalConnected} />
                {p.paypalConnected ? (
                  <Button variant="outline" size="sm" onClick={() => { invite(p.id); }}>
                    <UserPlus aria-hidden /> Invite
                  </Button>
                ) : (
                  <span className="text-xs text-slate-500">Has not connected PayPal yet, so cannot be paid</span>
                )}
              </li>
            ))}
            {results.length === 0 && <li className="py-6 text-center text-sm text-slate-500">Nobody matches. Try another profession, or invite by email.</li>}
          </ul>
          <div className="flex gap-2 border-t border-slate-100 pt-4">
            <Label htmlFor="email" className="sr-only">
              Invite by email
            </Label>
            <Input id="email" type="email" placeholder="someone@example.com" />
            <Button variant="outline" disabled>
              Invite by email
            </Button>
          </div>
        </Card>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-24">
        <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">What a release looks like</p>
        <Card className="space-y-3 p-5 text-sm">
          <p>
            If the buyer releases <span className="font-mono font-semibold">{formatMoney({ amountMinor: example, currency: "USD" })}</span>:
          </p>
          <ul className="space-y-1.5">
            {team.map((m, i) => (
              <li key={m.personId} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span aria-hidden className={cn("size-2.5 rounded-full", SWATCH[i % SWATCH.length])} />
                  {m.personId === "me" ? state.profile.name : DIRECTORY.find((p) => p.id === m.personId)?.name}
                </span>
                <span className="font-mono">{formatMoney({ amountMinor: parts[i] ?? 0, currency: "USD" })}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">Split by largest remainder: the parts always add up to the release, to the cent (constitution V).</p>
        </Card>
      </aside>
    </div>
  );
}
