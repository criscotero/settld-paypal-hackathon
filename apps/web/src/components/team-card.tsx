"use client";
// The contract's team (ADR-0009). Everyone sees who is on it and whether they approved the current
// version. The seller edits it while the contract is not agreed: find people in the directory,
// set each one's role and share, save. A collaborator sees only their own share (decision 6).
import { BadgeCheck, Search, Trash2, UserPlus } from "lucide-react";
import { useState, useTransition } from "react";
import { saveTeam, searchDirectory } from "@/app/team-actions";
import { ErrorBox } from "@/components/error-box";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import type { Contract, Schemas } from "@/lib/api-types";
import type { ActionError } from "@/lib/problem";
import { PROFESSION_LABELS, PROFESSIONS } from "@/lib/professions";
import { cn } from "@/lib/utils";
import { formatWeight, parseWeightPercent } from "@/lib/weights";

type Row = { userId: string | null; name: string; role: string; share: string; isNew: boolean };

export function TeamCard({ contract }: { contract: Contract }) {
  const v = contract.currentVersion;
  const editable = contract.myRole === "SELLER" && v.status !== "LOCKED";
  const [editing, setEditing] = useState(false);
  const team = contract.team ?? [];

  return (
    <Card id="team" className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Team
          {editable && !editing && (
            <Button size="sm" variant="outline" onClick={() => { setEditing(true); }}>
              Edit team
            </Button>
          )}
        </CardTitle>
        <p className="text-sm text-slate-500">Each release is split by these shares, and PayPal pays each person directly.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <TeamEditor contract={contract} onDone={() => { setEditing(false); }} />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {team.map((t) => (
              <li key={t.userId ?? "seller"} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-medium">
                    {t.displayName}
                    {t.isSeller && <Badge tone="good">Seller</Badge>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {t.role}
                    {t.headline ? ` · ${t.headline}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-mono">{t.shareBps === null ? "—" : `${formatWeight(t.shareBps)}%`}</span>
                  {v.status !== "DRAFT" && (
                    <span className={cn("flex items-center gap-1 text-xs", t.approvedCurrentVersion ? "text-emerald-700" : "text-slate-400")}>
                      {t.approvedCurrentVersion && <BadgeCheck className="size-3.5" aria-hidden />}
                      {t.approvedCurrentVersion ? "approved" : "pending"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {contract.myRole === "COLLABORATOR" && <p className="text-xs text-slate-500">You see your own share; the others&apos; shares are private.</p>}
      </CardContent>
    </Card>
  );
}

function TeamEditor({ contract, onDone }: { contract: Contract; onDone: () => void }) {
  const v = contract.currentVersion;
  const [rows, setRows] = useState<Row[]>(() =>
    (contract.team ?? []).map((t) => ({ userId: t.isSeller ? null : t.userId, name: t.displayName, role: t.role, share: t.shareBps === null ? "" : formatWeight(t.shareBps), isNew: false })),
  );
  const [query, setQuery] = useState("");
  const [profession, setProfession] = useState<Schemas["Profession"] | "">("");
  const [results, setResults] = useState<Schemas["DirectoryEntry"][] | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const shares = rows.map((r) => parseWeightPercent(r.share));
  const sum = shares.reduce((a, s) => a + (s.ok ? s.bps : 0), 0);
  const inTeam = new Set(rows.map((r) => r.userId));
  const patch = (i: number, change: Partial<Row>) => {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  };

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.userId ?? "seller"} className="space-y-1 rounded-lg border border-slate-200 p-2 text-sm">
            <p className="flex items-center justify-between font-medium">
              {r.name}
              {r.userId === null ? (
                <Badge tone="good">Seller</Badge>
              ) : (
                <Button size="sm" variant="ghost" aria-label={`Remove ${r.name}`} onClick={() => { setRows(rows.filter((_, j) => j !== i)); }}>
                  <Trash2 aria-hidden />
                </Button>
              )}
            </p>
            <div className="flex gap-2">
              <Input aria-label={`Role of ${r.name}`} value={r.role} maxLength={60} onChange={(e) => { patch(i, { role: e.target.value }); }} />
              <span className="flex w-28 items-center gap-1">
                <Input aria-label={`Share of ${r.name}`} inputMode="decimal" value={r.share} aria-invalid={r.share !== "" && shares[i]?.ok === false} onChange={(e) => { patch(i, { share: e.target.value }); }} />%
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className={cn("text-sm font-semibold", sum === 10_000 ? "text-emerald-700" : "text-amber-700")}>{sum === 10_000 ? "Shares add up to 100%." : `Shares add up to ${formatWeight(sum)}%. They must add up to 100%.`}</p>

      {rows.length < 5 && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3">
          <p className="text-sm font-medium">Add from the directory</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const r = await searchDirectory(query.trim(), profession);
                if (Array.isArray(r)) {
                  setResults(r);
                  setError(null);
                } else setError(r);
              });
            }}
          >
            {/* Its own full row: next to the profession filter it was too narrow to read (live test,
                2026-11-07). An exact email finds someone the seller already knows. */}
            <Input aria-label="Search the directory" placeholder="Name, skill or exact email" maxLength={254} value={query} onChange={(e) => { setQuery(e.target.value); }} className="min-w-0 basis-full" />
            <Select aria-label="Profession" value={profession} onChange={(e) => { setProfession(e.target.value as Schemas["Profession"] | ""); }} className="min-w-0 flex-1">
              <option value="">Any</option>
              {PROFESSIONS.map((p) => (
                <option key={p} value={p}>
                  {PROFESSION_LABELS[p]}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="outline" loading={pending} aria-label="Search">
              <Search aria-hidden />
            </Button>
          </form>
          {results !== null && (
            <ul className="divide-y divide-slate-200 text-sm">
              {results.filter((p) => !inTeam.has(p.userId) && p.userId !== contract.buyerId).map((p) => (
                <li key={p.userId} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{p.displayName}</span>
                    <span className="block truncate text-xs text-slate-500">{p.headline ?? p.professions.map((x) => PROFESSION_LABELS[x]).join(", ")}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRows([...rows, { userId: p.userId, name: p.displayName, role: p.professions[0] === undefined ? "Collaborator" : PROFESSION_LABELS[p.professions[0]], share: "", isNew: true }]);
                    }}
                  >
                    <UserPlus aria-hidden /> Add
                  </Button>
                </li>
              ))}
              {results.length === 0 && <li className="py-2 text-slate-500">Nobody in the directory matches.</li>}
            </ul>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={pending}
          disabled={sum !== 10_000 || shares.some((s) => !s.ok)}
          onClick={() => {
            const team = rows.map((r, i) => {
              const s = shares[i];
              return { userId: r.userId, role: r.role.trim(), shareBps: s?.ok ? s.bps : 0 };
            });
            startTransition(async () => {
              const result = await saveTeam(contract.id, v.version, v.snapshot, team, rows.filter((r) => r.isNew && r.userId !== null).map((r) => r.userId ?? ""));
              setError(result);
              if (result === null) onDone();
            });
          }}
        >
          Save team
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {v.status === "PENDING_APPROVAL" && <p className="text-xs text-slate-500">Saving creates a new version that everyone approves again.</p>}
      <ErrorBox error={error} />
    </div>
  );
}
