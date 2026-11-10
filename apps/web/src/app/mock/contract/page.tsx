"use client";
// The whole life of a milestone, clickable, with the same money rules as Core API
// (release-math.ts): weights, the required gate, a deterministic PASS or a buyer's approval
// counts, silence approves nothing new, and what was paid keeps counting. Timers are short so
// the demo moves; the real countdown is a contract term (48 h by default).
import { Bot, CheckCircle2, CircleDashed, Clock, Loader2, ShieldCheck, User, Wallet, XCircle, Zap } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ProgressSteps } from "@/components/progress-steps";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { humanize } from "@/lib/copy";
import { formatMoney } from "@/lib/money";
import type { Step } from "@/lib/progress";
import { splitLargestRemainder } from "@/lib/split";
import { cn } from "@/lib/utils";
import { formatWeight } from "@/lib/weights";
import { DIRECTORY, MILESTONE } from "../mock-data";
import { addLog, useMock } from "../store";
import type { Flow, MockState, Stage, Verdict } from "../store";

const money = (amountMinor: number) => formatMoney({ amountMinor, currency: MILESTONE.currency });
const FULL = 10_000;

// What counts now: a deterministic PASS, or the buyer's approval, or paid in an earlier release.
function counted(flow: Flow): Set<string> {
  const paid = flow.releases.flatMap((r) => r.countedIds);
  return new Set([
    ...MILESTONE.criteria.filter((c) => c.level === "AUTOMATIC" && flow.verdicts[c.id] === "PASS").map((c) => c.id),
    ...flow.approvedByBuyer,
    ...paid,
  ]);
}

function decide(flow: Flow) {
  const ids = counted(flow);
  const bps = MILESTONE.criteria.filter((c) => ids.has(c.id)).reduce((a, c) => a + c.weightBps, 0);
  const requiredOk = MILESTONE.criteria.every((c) => !c.required || ids.has(c.id));
  const released = flow.releases.reduce((a, r) => a + r.amountMinor, 0);
  const cumulative = Math.floor((MILESTONE.amountMinor * bps) / FULL);
  const amount = requiredOk ? Math.max(0, cumulative - released) : 0;
  return { ids, bps, amount, released, final: bps === FULL && requiredOk };
}

function release(flow: Flow, how: string): Flow {
  const d = decide(flow);
  if (d.amount <= 0) {
    const back: Stage = d.released > 0 ? "PARTIALLY_RELEASED" : "IN_PROGRESS";
    return addLog({ ...flow, stage: back, windowEndsAt: null }, "Countdown ended and nothing new counts. Back to the seller.");
  }
  const next: Flow = {
    ...flow,
    stage: d.final ? "RELEASED" : "PARTIALLY_RELEASED",
    windowEndsAt: null,
    releases: [...flow.releases, { seq: flow.releases.length + 1, amountMinor: d.amount, countedBps: d.bps, countedIds: [...d.ids], final: d.final, at: new Date().toISOString() }],
  };
  return addLog(next, `${how}: ${money(d.amount)} released (${formatWeight(d.bps)}% of the criteria count). PayPal captures it${d.final ? " and closes the hold" : "; the rest stays held"}.`);
}

const PATH: Stage[] = ["APPROVED", "FUNDED", "IN_PROGRESS", "VERIFYING", "OBJECTION_WINDOW", "RELEASED"];

function steps(stage: Stage): Step[] {
  const at = stage === "PARTIALLY_RELEASED" ? 4 : stage === "CLOSED" ? 5 : PATH.indexOf(stage);
  return PATH.map((s, i) => ({
    id: s,
    title: s === "OBJECTION_WINDOW" ? "Countdown" : s === "RELEASED" && stage === "CLOSED" ? "Closed" : humanize(s),
    status: i < at || (i === at && (stage === "RELEASED" || stage === "CLOSED")) ? "done" : i === at ? (stage === "PARTIALLY_RELEASED" ? "problem" : "current") : "upcoming",
  }));
}

const VERDICT: Record<Verdict, { icon: typeof CheckCircle2; tone: string; label: string }> = {
  WAITING: { icon: CircleDashed, tone: "text-slate-400", label: "Not checked yet" },
  CHECKING: { icon: Loader2, tone: "text-sky-600 animate-spin", label: "Checking…" },
  PASS: { icon: CheckCircle2, tone: "text-emerald-600", label: "Pass" },
  FAIL: { icon: XCircle, tone: "text-red-600", label: "Fail" },
  NEEDS_HUMAN: { icon: User, tone: "text-amber-600", label: "Needs the buyer" },
};

export default function LiveContractMock() {
  const { state, set } = useMock();
  const [viewer, setViewer] = useState<"BUYER" | "SELLER">("BUYER");
  const [paypalOpen, setPaypalOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const flow = state.flow;
  const setFlow = (f: (x: Flow) => Flow) => {
    set((s: MockState) => ({ ...s, flow: f(s.flow) }));
  };

  // The mock Engine: one criterion at a time, so the checklist fills in live.
  const verifyingRound = useRef<number | null>(null);
  useEffect(() => {
    if (flow.stage !== "VERIFYING" || verifyingRound.current === flow.round) return;
    verifyingRound.current = flow.round;
    const round = flow.round;
    const timers = MILESTONE.criteria.map((c, i) =>
      setTimeout(() => {
        setFlow((f) => {
          if (f.stage !== "VERIFYING" || f.round !== round) return f;
          const v: Verdict = round === 1 ? c.firstVerdict : c.level === "HUMAN" ? "NEEDS_HUMAN" : "PASS";
          return addLog({ ...f, verdicts: { ...f.verdicts, [c.id]: v } }, `${c.text}: ${VERDICT[v].label}.`);
        });
      }, 900 * (i + 1)),
    );
    timers.push(
      setTimeout(() => {
        setFlow((f) => {
          if (f.stage !== "VERIFYING" || f.round !== round) return f;
          // G-RELEASABLE: no required FAIL, and something could still be released.
          const requiredFailed = MILESTONE.criteria.some((c) => c.required && f.verdicts[c.id] === "FAIL");
          const possible = { ...f, approvedByBuyer: MILESTONE.criteria.filter((c) => f.verdicts[c.id] !== "FAIL").map((c) => c.id) };
          if (requiredFailed || decide(possible).amount <= 0) {
            const back: Stage = f.releases.length > 0 ? "PARTIALLY_RELEASED" : "IN_PROGRESS";
            return addLog({ ...f, stage: back }, "Verification found nothing new to release.");
          }
          return addLog({ ...f, stage: "OBJECTION_WINDOW", windowEndsAt: Date.now() + MILESTONE.countdownSeconds * 1000 }, `Verification done. The countdown starts: ${String(MILESTONE.countdownSeconds)} s to approve or object.`);
        });
      }, 900 * (MILESTONE.criteria.length + 1)),
    );
    return () => {
      timers.forEach(clearTimeout);
      verifyingRound.current = null;
    };
    // Keyed on stage and round only: one run of the mock Engine per delivery.
  }, [flow.stage, flow.round]);

  // The countdown timer. Like objections.window.expire: if the stage moved on (the buyer
  // approved or objected first), it does nothing.
  useEffect(() => {
    if (flow.stage !== "OBJECTION_WINDOW") return;
    const id = setInterval(() => {
      setNow(Date.now());
      setFlow((f) => (f.stage === "OBJECTION_WINDOW" && f.windowEndsAt !== null && Date.now() >= f.windowEndsAt ? release(f, "Countdown ended with no objection") : f));
    }, 250);
    return () => {
      clearInterval(id);
    };
    // Keyed on stage only: one interval per countdown.
  }, [flow.stage]);

  const d = decide(flow);
  const funded = flow.stage === "APPROVED" ? 0 : MILESTONE.amountMinor;
  const returned = flow.stage === "CLOSED" ? funded - d.released : 0;
  const held = funded - d.released - returned;
  const left = flow.windowEndsAt === null ? 0 : Math.max(0, Math.ceil((flow.windowEndsAt - now) / 1000));
  const team = state.team.map((m) => ({ ...m, name: m.personId === "me" ? state.profile.name : (DIRECTORY.find((p) => p.id === m.personId)?.name ?? "?") }));
  const buyer = viewer === "BUYER";

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 p-6">
          <div>
            <p className="text-sm text-slate-500">{MILESTONE.contract}</p>
            <h1 className="text-2xl font-bold tracking-tight">{MILESTONE.title}</h1>
            <p className="mt-1 text-sm text-slate-600">
              Buyer: {MILESTONE.buyer} · Team: {team.map((t) => `${t.name} ${formatWeight(t.shareBps)}%`).join(", ")}
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-slate-100 p-1 text-sm" role="group" aria-label="View as">
            {(["BUYER", "SELLER"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={viewer === v} onClick={() => { setViewer(v); }} className={cn("rounded-md px-3 py-1 font-medium", viewer === v ? "bg-white shadow-sm" : "text-slate-500")}>
                View as {v === "BUYER" ? "buyer" : "seller"}
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-slate-100 bg-slate-50/50 px-6 pt-5 pb-6">
          <ProgressSteps steps={steps(flow.stage)} />
        </div>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Card className="space-y-4 p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Acceptance criteria</h2>
              {flow.round > 0 && <Badge tone="info">Delivery {flow.round}</Badge>}
            </div>
            <ul className="space-y-2">
              {MILESTONE.criteria.map((c) => {
                const v = flow.verdicts[c.id] ?? "WAITING";
                const Icon = VERDICT[v].icon;
                const paid = flow.releases.some((r) => r.countedIds.includes(c.id));
                return (
                  <li key={c.id} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
                    <Icon className={cn("mt-0.5 size-5 shrink-0", VERDICT[v].tone)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {c.text}
                        <span className="text-xs font-normal text-slate-400">
                          {c.level === "HUMAN" ? <User className="inline size-3" aria-hidden /> : <Zap className="inline size-3" aria-hidden />} {formatWeight(c.weightBps)}%{c.required ? " · required" : ""}
                        </span>
                        {paid && <Badge tone="good">Paid</Badge>}
                      </p>
                      <p className="text-xs text-slate-500">
                        <span className="sr-only">{VERDICT[v].label}: </span>
                        {v === "WAITING" ? "Checked after delivery." : v === "CHECKING" ? "Settld is checking…" : v === "FAIL" && flow.round === 1 ? (c.failure ?? c.evidence) : v === "NEEDS_HUMAN" && flow.approvedByBuyer.includes(c.id) ? "Approved by the buyer." : c.level === "AUTOMATIC" && v === "PASS" ? c.evidence.replace("404", "200") : c.evidence}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <Bot className="size-3.5" aria-hidden /> An AI verdict alone never counts. Human criteria count only when the buyer approves them.
            </p>
          </Card>

          <Card className="space-y-4 p-6">
            <h2 className="font-semibold">{buyer ? "What you can do (buyer)" : "What you can do (seller)"}</h2>
            <Actions viewer={viewer} flow={flow} left={left} amountToRelease={d.amount} openPaypal={() => { setPaypalOpen(true); }} setFlow={setFlow} />
          </Card>

          {paypalOpen && (
            <Card className="space-y-4 border-2 border-[#0070ba] p-6" role="region" aria-label="PayPal sandbox approval">
              <p className="text-lg font-bold text-[#003087]">
                Pay<span className="text-[#0070ba]">Pal</span> <span className="text-xs font-normal text-slate-500">sandbox · simulated</span>
              </p>
              <p className="text-sm">
                Settld asks PayPal to <strong>reserve</strong> {money(MILESTONE.amountMinor)} on your account for “{MILESTONE.title}”. Nothing is charged now.
              </p>
              <div className="flex gap-2">
                <Button
                  className="bg-[#0070ba] hover:bg-[#005ea6]"
                  onClick={() => {
                    setPaypalOpen(false);
                    setFlow((f) => addLog({ ...f, stage: "FUNDED" }, `PayPal reserved ${money(MILESTONE.amountMinor)} on the buyer's account (authorization valid 29 days).`));
                  }}
                >
                  Agree and continue
                </Button>
                <Button variant="outline" onClick={() => { setPaypalOpen(false); }}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24">
          <Card className="space-y-3 p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <Wallet className="size-4 text-slate-400" aria-hidden /> Where is the money
            </h2>
            <dl className="space-y-1.5 text-sm">
              <Row label="Reserved in PayPal" value={money(held)} tone="text-sky-700" />
              <Row label="Paid to the team" value={money(d.released)} tone="text-emerald-700" />
              <Row label="Returned to the buyer" value={money(returned)} tone="text-slate-600" />
            </dl>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${money(d.released)} paid, ${money(held)} reserved, ${money(returned)} returned`}>
              <span className="bg-emerald-500" style={{ width: `${String((d.released / MILESTONE.amountMinor) * 100)}%` }} />
              <span className="bg-sky-400" style={{ width: `${String((held / MILESTONE.amountMinor) * 100)}%` }} />
              <span className="bg-slate-300" style={{ width: `${String((returned / MILESTONE.amountMinor) * 100)}%` }} />
            </div>
            <p className="flex items-center gap-1.5 border-t border-slate-100 pt-3 text-xs text-slate-500">
              <ShieldCheck className="size-3.5" aria-hidden /> Settld never holds money: PayPal reserves it and pays each person directly.
            </p>
          </Card>

          {flow.releases.length > 0 && (
            <Card className="space-y-3 p-5">
              <h2 className="font-semibold">Releases</h2>
              {flow.releases.map((r) => {
                const parts = splitLargestRemainder(r.amountMinor, team.map((t) => t.shareBps));
                return (
                  <div key={r.seq} className="space-y-1 text-sm">
                    <p className="flex justify-between font-medium">
                      Release {r.seq} {r.final && <Badge tone="good">final</Badge>}
                      <span className="font-mono">{money(r.amountMinor)}</span>
                    </p>
                    {team.map((t, i) => (
                      <p key={t.personId} className="flex justify-between text-xs text-slate-500">
                        <span>
                          → {t.name} ({formatWeight(t.shareBps)}%)
                        </span>
                        <span className="font-mono">{money(parts[i] ?? 0)}</span>
                      </p>
                    ))}
                  </div>
                );
              })}
              <Link href="/mock/receipt" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}>
                See the receipt
              </Link>
            </Card>
          )}

          <Card className="space-y-2 p-5">
            <h2 className="font-semibold">Activity</h2>
            <ol className="max-h-72 space-y-2 overflow-y-auto text-xs">
              {flow.log.map((l, i) => (
                <li key={`${l.at}-${String(i)}`} className="border-l-2 border-slate-200 pl-2">
                  <span className="text-slate-400">{new Date(l.at).toLocaleTimeString()}</span> {l.text}
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className={cn("font-mono font-semibold", tone)}>{value}</dd>
    </div>
  );
}

function Actions({ viewer, flow, left, amountToRelease, openPaypal, setFlow }: { viewer: "BUYER" | "SELLER"; flow: Flow; left: number; amountToRelease: number; openPaypal: () => void; setFlow: (f: (x: Flow) => Flow) => void }) {
  const [url, setUrl] = useState("https://staging.acme.dev");
  const [approveHuman, setApproveHuman] = useState(false);
  const [reason, setReason] = useState("");
  const buyer = viewer === "BUYER";
  const human = MILESTONE.criteria.find((c) => c.level === "HUMAN");
  const wait = (who: string) => <p className="text-sm text-slate-500">Waiting for {who}. Switch the view at the top to act as them.</p>;

  const deliver = () => {
    setFlow((f) =>
      addLog(
        { ...f, stage: "VERIFYING", round: f.round + 1, verdicts: Object.fromEntries(MILESTONE.criteria.map((c) => [c.id, "CHECKING"])), approvedByBuyer: f.approvedByBuyer.filter((id) => f.releases.some((r) => r.countedIds.includes(id))) },
        `Seller delivered ${url}. Its content is hashed now, so what gets verified is exactly what was delivered.`,
      ),
    );
  };

  switch (flow.stage) {
    case "APPROVED":
      return buyer ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-600">Reserve the money in PayPal. Nothing is charged until the work is verified and the countdown ends.</p>
          <Button variant="primary" onClick={openPaypal}>
            Reserve {money(MILESTONE.amountMinor)} with PayPal
          </Button>
        </div>
      ) : (
        wait("the buyer to fund")
      );
    case "FUNDED":
      return buyer ? wait("the seller to start") : (
        <Button variant="primary" onClick={() => { setFlow((f) => addLog({ ...f, stage: "IN_PROGRESS" }, "Seller started work.")); }}>
          Start work
        </Button>
      );
    case "IN_PROGRESS":
    case "PARTIALLY_RELEASED":
      return buyer ? (
        wait(flow.stage === "PARTIALLY_RELEASED" ? "the seller to fix what is missing, or accept the partial payment" : "the delivery")
      ) : (
        <div className="space-y-3">
          {flow.stage === "PARTIALLY_RELEASED" && <p className="text-sm text-slate-600">Part was paid. Fix what failed and deliver again, or accept what you got and return the rest to the buyer.</p>}
          <Input aria-label="Link to the delivered work" type="url" value={url} onChange={(e) => { setUrl(e.target.value); }} />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={deliver}>
              {flow.round === 0 ? "Deliver" : "Deliver the fix"}
            </Button>
            {flow.stage === "PARTIALLY_RELEASED" && (
              <Button variant="outline" onClick={() => { setFlow((f) => addLog({ ...f, stage: "CLOSED" }, "Seller accepted the partial payment. PayPal returns the rest to the buyer (void).")); }}>
                Accept and return the rest
              </Button>
            )}
          </div>
        </div>
      );
    case "VERIFYING":
      return <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="size-4 animate-spin" aria-hidden /> Settld is checking each criterion against the delivery.</p>;
    case "OBJECTION_WINDOW":
      return (
        <div className="space-y-4">
          <p className="flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            <Clock className="size-4" aria-hidden /> What counts is released in <span className="font-mono font-bold tabular-nums">{left}s</span> unless the buyer objects. Silence approves nothing new.
          </p>
          {buyer ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                {human && flow.verdicts[human.id] === "NEEDS_HUMAN" && !flow.approvedByBuyer.includes(human.id) && (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={approveHuman} onChange={(e) => { setApproveHuman(e.target.checked); }} />
                    I approve: {human.text} ({formatWeight(human.weightBps)}%)
                  </label>
                )}
                <Button
                  variant="primary"
                  onClick={() => {
                    setFlow((f) => release(approveHuman && human ? { ...f, approvedByBuyer: [...new Set([...f.approvedByBuyer, human.id])] } : f, "Buyer approved early"));
                  }}
                >
                  Approve and release now
                </Button>
                <p className="text-xs text-slate-500">Releases {money(amountToRelease)}{approveHuman && human ? ` + ${formatWeight(human.weightBps)}% for the approved criterion` : ""}.</p>
              </div>
              <div className="space-y-2">
                <Textarea aria-label="What is wrong" placeholder="What is wrong, in at least 20 characters" value={reason} onChange={(e) => { setReason(e.target.value); }} className="min-h-14" />
                <Button
                  variant="outline"
                  disabled={reason.trim().length < 20}
                  onClick={() => {
                    setFlow((f) => addLog({ ...f, stage: f.releases.length > 0 ? "PARTIALLY_RELEASED" : "IN_PROGRESS", windowEndsAt: null }, `Buyer objected: “${reason.trim()}”. The countdown stops and nothing is released; the seller fixes and delivers again.`));
                  }}
                >
                  Object
                </Button>
              </div>
            </div>
          ) : (
            wait("the countdown or the buyer's decision")
          )}
        </div>
      );
    case "RELEASED":
    case "CLOSED":
      return (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="size-4" aria-hidden /> {flow.stage === "RELEASED" ? "Fully paid. The milestone is settled." : "Closed: part paid, the rest returned to the buyer."}
          </p>
          <Link href="/mock/receipt" className={buttonVariants({ variant: "primary" })}>
            See the receipt
          </Link>
        </div>
      );
  }
}
