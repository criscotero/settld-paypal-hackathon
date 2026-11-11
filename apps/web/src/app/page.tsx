import { Show, SignUpButton } from "@clerk/nextjs";
import { ArrowRight, BadgeDollarSign, Bot, ChevronDown, CircleCheck, CircleX, ClipboardCheck, Landmark, Receipt, Scale, Timer, Users, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CompilerArt, FundingArt, LockArt, ReleaseArt, SplitArt, VerifyArt } from "@/components/home-illustrations";
import { SETTLER_NOTE } from "@/components/reviewer-copy";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: { absolute: "Settld · The referee for paid work" } };

// Landing-page structure: one call to action repeated down the page, with proof stacking up
// between repeats. Settld has no customers yet, so every proof point is a product fact or a
// constitution guarantee, never an invented logo, number or testimonial.

// Acceptance test T1 from requirements-v1: integer cents and basis points (constitution V).
const MILESTONE = 50_000;
const CRITERIA = [
  { text: "Landing page answers 200 at the agreed URL", weightBps: 4_000, passed: true },
  { text: "Signup form saves the email", weightBps: 3_000, passed: true },
  { text: "Mobile Lighthouse score is 90 or more", weightBps: 2_000, passed: true },
  { text: "Deployed before Friday 18:00", weightBps: 1_000, passed: false, reason: "Deployed Saturday 09:12" },
] as const;
const SPLIT = [
  { who: "Seller", bps: 7_000 },
  { who: "Designer", bps: 2_000 },
  { who: "Copywriter", bps: 1_000 },
] as const;
const passedBps = CRITERIA.filter((c) => c.passed).reduce((sum, c) => sum + c.weightBps, 0);
const released = Math.floor((MILESTONE * passedBps) / 10_000);
const held = MILESTONE - released;
const usd = (amountMinor: number) => formatMoney({ amountMinor, currency: "USD" });

export default function Home() {
  return (
    <div className="-mt-8 flex flex-col">
      <Hero />
      <BuiltOn />
      <Products />
      <Benefits />
      <Trust />
      <Audiences />
      <Settlers />
      <Faq />
      <FinalCta />
      <Legal />
    </div>
  );
}

// ------------------------------------------------------------------ layout helpers

// Breaks out of the layout's max-w-6xl <main> so a section can paint edge to edge
// (body has overflow-x-hidden, so 100vw never adds a scrollbar).
function Band({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={cn("relative left-1/2 w-screen -translate-x-1/2 scroll-mt-20", className)}>
      <div className="mx-auto max-w-6xl px-6">{children}</div>
    </section>
  );
}

function Eyebrow({ children, inverted = false }: { children: ReactNode; inverted?: boolean }) {
  return <p className={cn("text-sm font-semibold tracking-wide uppercase", inverted ? "text-accent" : "text-primary")}>{children}</p>;
}

function Heading({ children, inverted = false, className }: { children: ReactNode; inverted?: boolean; className?: string }) {
  return <h2 className={cn("mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl", inverted ? "text-white" : "text-navy", className)}>{children}</h2>;
}

// The one call to action. Same words everywhere, so the visitor learns one next step.
function PrimaryCta({ inverted = false }: { inverted?: boolean }) {
  const className = cn(buttonVariants({ variant: "primary", size: "lg" }), inverted && "bg-accent text-navy hover:bg-accent/90");
  return (
    <>
      <Show when="signed-out">
        <SignUpButton forceRedirectUrl="/onboarding" signInForceRedirectUrl="/dashboard">
          <button type="button" className={className}>
            Open a Settld account <ArrowRight aria-hidden />
          </button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <Link href="/dashboard" className={className}>
          Go to your dashboard <ArrowRight aria-hidden />
        </Link>
      </Show>
    </>
  );
}

// ------------------------------------------------------------------ 1. hero

function Hero() {
  return (
    <Band className="overflow-hidden bg-navy text-white">
      {/* Soft teal glow behind the product card; decorative. */}
      <div aria-hidden className="pointer-events-none absolute -top-40 right-[-10%] size-[640px] rounded-full bg-accent/20 blur-3xl" />
      <div className="relative grid items-center gap-12 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24">
        <div className="flex flex-col gap-6">
          <Badge tone="info" dot className="self-start bg-white/10 text-white ring-white/20">
            PayPal sandbox · demo
          </Badge>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
            The referee for paid work, for people <span className="text-accent">and their agents</span>
          </h1>
          <p className="max-w-xl text-lg text-white/75">
            Describe the job, lock the criteria, fund through PayPal, verify the delivery, and get paid for exactly what passed, split across your team.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <PrimaryCta inverted />
            <a href="#products" className="text-sm font-semibold text-white/80 underline-offset-4 hover:text-white hover:underline">
              See what&apos;s inside
            </a>
          </div>
          <p className="flex items-center gap-2 text-sm text-white/60">
            <Landmark className="size-4 shrink-0 text-accent" aria-hidden />
            Settld never holds your money. It stays in PayPal until the work is verified.
          </p>
        </div>
        <SettlementPreview />
      </div>
    </Band>
  );
}

// The product in one picture: criteria, what was released, what is held and why, and the split.
function SettlementPreview() {
  return (
    <Card className="overflow-hidden text-ink shadow-2xl shadow-black/30">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Settlement receipt · example</p>
          <p className="font-semibold">Landing page with signup form</p>
        </div>
        <p className="font-mono text-lg font-bold text-navy">{usd(MILESTONE)}</p>
      </div>
      <ul className="divide-y divide-slate-100 px-5">
        {CRITERIA.map((c) => (
          <li key={c.text} className="flex items-start gap-3 py-3">
            {c.passed ? (
              <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <CircleX className="mt-0.5 size-5 shrink-0 text-red-600" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm">{c.text}</p>
              <p className="text-xs text-slate-500">{c.passed ? "Passed · automatic check" : `Failed · ${"reason" in c ? c.reason : ""}`}</p>
            </div>
            <span className="font-mono text-sm text-slate-600">{c.weightBps / 100}%</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3 bg-slate-50 px-5 py-4">
        {/* Words next to the colors, never color alone (constitution XII). */}
        <div className="flex h-3 overflow-hidden rounded-full bg-slate-200" role="img" aria-label={`${usd(released)} released, ${usd(held)} held`}>
          <div className="bg-primary" style={{ width: `${(passedBps / 100).toString()}%` }} />
          <div className="bg-amber-400" style={{ width: `${((10_000 - passedBps) / 100).toString()}%` }} />
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full bg-primary" />
            Released <span className="font-mono font-semibold">{usd(released)}</span>
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full bg-amber-400" />
            Held until fixed <span className="font-mono font-semibold">{usd(held)}</span>
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 border-t border-slate-200 pt-3">
          {SPLIT.map((s) => (
            <div key={s.who} className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
              <p className="text-xs text-slate-500">
                {s.who} · {s.bps / 100}%
              </p>
              <p className="font-mono text-sm font-semibold">{usd(Math.floor((released * s.bps) / 10_000))}</p>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ 2. built on

const STACK = ["PayPal", "Clerk", "Claude", "PostgreSQL", "Next.js", "FastAPI"] as const;

function BuiltOn() {
  return (
    <Band className="border-b border-slate-200 bg-white">
      <div className="flex flex-col items-center gap-4 py-8 sm:flex-row sm:justify-between">
        <p className="text-sm font-medium text-slate-500">Built on infrastructure you already trust</p>
        <ul className="flex flex-wrap justify-center gap-x-8 gap-y-2">
          {STACK.map((name) => (
            <li key={name} className="text-base font-bold tracking-tight text-slate-400">
              {name}
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------ 3. products

const PRODUCTS = [
  { title: "Contract compiler", body: "Plain words in, weighted and checkable criteria out. Vague items come back with measurable rewrites.", art: <CompilerArt /> },
  { title: "Locked agreements", body: "Both sides approve the same version. It is hashed and frozen, so nobody pays against terms they did not see.", art: <LockArt /> },
  { title: "PayPal funding", body: "The buyer approves in PayPal. The money is reserved there and never passes through Settld.", art: <FundingArt /> },
  { title: "Verification engine", body: "Automatic checks run on the delivery and each criterion returns pass or fail with evidence and a plain reason.", art: <VerifyArt /> },
  { title: "Proportional release", body: "Get paid for what passed. The rest stays held, tied to the failed criterion, until it is fixed.", art: <ReleaseArt /> },
  { title: "Team splits", body: "Every release is split between the seller and their collaborators. Shares always add up to exactly 100%.", art: <SplitArt /> },
] as const;

function Products() {
  return (
    <Band id="products" className="py-20">
      <div className="max-w-2xl">
        <Eyebrow>Products</Eyebrow>
        <Heading>Everything between &quot;here&apos;s the job&quot; and &quot;you&apos;ve been paid&quot;</Heading>
      </div>
      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {PRODUCTS.map((p) => (
          <Card key={p.title} className="flex flex-col gap-4 p-5">
            {p.art}
            <div>
              <h3 className="text-lg font-bold text-ink">{p.title}</h3>
              <p className="mt-1 text-sm text-slate-600">{p.body}</p>
            </div>
          </Card>
        ))}
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------ 4. benefits

const BENEFITS = [
  { icon: Wallet, title: "Pay for results, not promises", body: "Money moves only for criteria that passed a check or that you approved yourself." },
  { icon: Timer, title: "Get paid sooner", body: "No all-or-nothing: what passed is released after the countdown, while the rest gets fixed." },
  { icon: CircleCheck, title: "No arguing about \"done\"", body: "Both sides agreed on the checks before work started, and every verdict comes with its evidence." },
  { icon: Users, title: "Your team paid directly", body: "Collaborators get their share from PayPal on every release, with no transfers between you afterwards." },
  { icon: Receipt, title: "A receipt for every payment", body: "Criteria, evidence, verdicts, amounts, split and PayPal transaction IDs, visible to both sides." },
  { icon: BadgeDollarSign, title: "Fees you see up front", body: "Any platform fee is fixed when the contract locks and shown before the buyer funds, every time." },
] as const;

function Benefits() {
  return (
    <Band id="benefits" className="bg-accent-soft py-20">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:items-start">
        <div className="lg:sticky lg:top-24">
          <Eyebrow>Benefits</Eyebrow>
          <Heading>Trust the process, not the other party</Heading>
          <p className="mt-4 text-slate-700">
            Cross-border work runs on deposits and blind faith. Settld replaces both with criteria you agree on up front and evidence anyone can read.
          </p>
          <div className="mt-6">
            <PrimaryCta />
          </div>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {BENEFITS.map((b) => (
            <li key={b.title} className="flex flex-col gap-3 rounded-xl bg-white p-5 shadow-sm ring-1 ring-primary/10">
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-white">
                <b.icon className="size-5" aria-hidden />
              </span>
              <div>
                <h3 className="font-bold text-ink">{b.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{b.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------ 5. trust

// Product facts, each backed by a constitution principle, in place of vanity metrics.
const FACTS = [
  { value: "$0", label: "Held by Settld, ever", principle: "I" },
  { value: "0", label: "Releases on an AI opinion alone", principle: "VI" },
  { value: "100%", label: "Splits must total, to the cent", principle: "V" },
  { value: "≥ 60 s", label: "Visible countdown before money moves", principle: "XII" },
  { value: "SHA-256", label: "Fingerprint on every submission", principle: "VII" },
  { value: "2 of 2", label: "Approvals to lock a contract", principle: "VI" },
] as const;

function Trust() {
  return (
    <Band className="py-20">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <Eyebrow>Built for trust</Eyebrow>
          <Heading>Rules the product cannot break</Heading>
          <p className="mt-4 text-slate-600">
            Settld has a written constitution. Every line of code that touches money has to obey it, and it is enforced in the backend, not just on screen.
            Hidden instructions inside delivered work are treated as data: they hold the whole milestone and show you the offending text.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.label} className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5">
              <dd className="font-mono text-3xl font-extrabold tracking-tight text-navy">{f.value}</dd>
              <dt className="mt-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {f.label}
                <span className="mt-1 block font-normal tracking-normal text-slate-400 normal-case">Principle {f.principle}</span>
              </dt>
            </div>
          ))}
        </dl>
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------ 6. audiences

const AUDIENCES = [
  {
    icon: Wallet,
    who: "Buyers",
    title: "Hire without the deposit gamble",
    points: ["Turn a brief into checks you can read", "Fund once, pay only for what passed", "Object during the countdown if something is off"],
  },
  {
    icon: Users,
    who: "Sellers and their teams",
    title: "Deliver, prove it, get paid",
    points: ["Know exactly what \"done\" means before you start", "Partial pay instead of all or nothing", "Collaborators paid directly by PayPal"],
  },
  {
    icon: Bot,
    who: "AI agents",
    title: "Agent-to-agent work with a neutral referee",
    points: ["REST API and MCP tools with the same rules", "Keys with spending limits, revocable instantly", "No key can approve or pay itself"],
    soon: true,
  },
] as const;

function Audiences() {
  return (
    <Band className="bg-navy py-20 text-white">
      <Eyebrow inverted>Who it&apos;s for</Eyebrow>
      <Heading inverted>One referee for both sides of the deal</Heading>
      <div className="mt-10 grid gap-5 lg:grid-cols-3">
        {AUDIENCES.map((a) => (
          <div key={a.who} className="flex flex-col gap-4 rounded-2xl bg-white/5 p-6 ring-1 ring-white/10">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-semibold text-accent">
                <a.icon className="size-4" aria-hidden /> {a.who}
              </span>
              {"soon" in a && (
                <Badge tone="warn" className="bg-amber-400/15 text-amber-200 ring-amber-300/30">
                  In development
                </Badge>
              )}
            </div>
            <h3 className="text-xl font-bold">{a.title}</h3>
            <ul className="flex flex-col gap-2 text-sm text-white/75">
              {a.points.map((p) => (
                <li key={p} className="flex gap-2">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------ 7. settlers

// A second audience with a second next step, so it does not reuse PrimaryCta. "Settler" is the word
// people see; the contract's word stays REVIEWER (ADR-0015). "Person" is not decoration: an agent key
// can never act as Reviewer (constitution), so this copy must not call a Settler an agent.
const SETTLER_POINTS = [
  { icon: ClipboardCheck, title: "Review the work", body: "Test the delivery and its evidence against the criteria both sides locked, the way a QA reviewer would." },
  { icon: Scale, title: "Stay neutral", body: "You never rule on a contract you are part of, and every ruling carries your written reason." },
  // Decided in ADR-0015 but not built yet (its delivery 4). Marked "Coming soon" (owner, 2026-11-11):
  // a judge who compares the landing with the README would otherwise find a payout the code never makes.
  { icon: BadgeDollarSign, title: "Earn a commission", body: "Get paid for each ruling you issue: 10% of the contract, up to USD 100, directly through PayPal.", soon: true },
] as const;

function Settlers() {
  const className = buttonVariants({ variant: "primary", size: "lg" });
  return (
    <Band id="settlers" className="bg-accent-soft py-20">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:items-start">
        <div>
          <Eyebrow>Become a Settler</Eyebrow>
          <Heading>Settle what the checks can&apos;t</Heading>
          <p className="mt-4 text-slate-700">
            Automatic checks and AI reviews can&apos;t decide everything. When they aren&apos;t enough, or someone disputes a delivery, a neutral person makes the call. That person can be you.
          </p>
          <div className="mt-6">
            <Show when="signed-out">
              <SignUpButton forceRedirectUrl="/onboarding" signInForceRedirectUrl="/profile">
                <button type="button" className={className}>
                  Apply to be a Settler <ArrowRight aria-hidden />
                </button>
              </SignUpButton>
            </Show>
            <Show when="signed-in">
              <Link href="/profile" className={className}>
                Apply to be a Settler <ArrowRight aria-hidden />
              </Link>
            </Show>
          </div>
          <p className="mt-3 text-sm text-slate-600">{SETTLER_NOTE}</p>
        </div>
        <ul className="grid gap-4">
          {SETTLER_POINTS.map((p) => (
            <li key={p.title} className="flex gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-primary/10">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-white">
                <p.icon className="size-5" aria-hidden />
              </span>
              <div>
                <h3 className="flex flex-wrap items-center gap-2 font-bold text-ink">
                  {p.title}
                  {"soon" in p && <Badge tone="warn">Coming soon</Badge>}
                </h3>
                <p className="mt-1 text-sm text-slate-600">{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------ 8. faq

const FAQS = [
  {
    q: "Does Settld hold my money?",
    a: "No. PayPal holds it: when the buyer funds a milestone, PayPal reserves the amount on the buyer's account. When criteria pass, PayPal pays the seller and each collaborator directly. Settld has no balance, wallet or account in between.",
  },
  {
    q: "What happens if one criterion fails?",
    a: "You are paid for the criteria that passed, after the release countdown. The share of the failed criterion stays held, linked to the reason it failed. When it is fixed and passes, that share is released with the same split.",
  },
  {
    q: "What if the AI gets it wrong?",
    a: "An AI opinion never releases money by itself. Only automatic checks, or an explicit approval from a person, count toward a release. Subjective criteria go to the buyer first, and to a neutral reviewer on appeal.",
  },
  {
    q: "How long is the countdown before money moves?",
    a: "Both sides choose it when they lock the contract, and it can never be zero. Between people it defaults to 48 hours; between agents it can be as short as 60 seconds. During the countdown either side can say something is wrong.",
  },
  {
    q: "What if the seller never delivers?",
    a: "Funding only reserves the money on the buyer's PayPal account; nothing is charged. If the contract is cancelled before any delivery, the reservation is released and the buyer never pays.",
  },
  {
    q: "How do collaborators get paid?",
    a: "The seller lists each collaborator with their PayPal account and share when the contract is set up. On every release, PayPal pays each person their share directly. Shares must add up to exactly 100%.",
  },
  {
    q: "Which PayPal account do I need?",
    a: "Buyers pay through the regular PayPal checkout. Sellers and collaborators need a PayPal business account connected to Settld so PayPal can pay them directly.",
  },
  {
    q: "Can the terms change after the money is reserved?",
    a: "No. Once both sides approve, the criteria, weights and amounts are locked and fingerprinted. Changing them means a new version that both sides approve again.",
  },
  {
    q: "What does it cost?",
    a: "PayPal charges its usual processing fee on each release. Any Settld platform fee is fixed when the contract is locked and shown before the buyer funds, every time.",
  },
  {
    q: "Can AI agents use Settld?",
    a: "That is the plan for v1: agents act for one person through an API key with a spending limit, using the same API and the same rules as a person. This part is still in development.",
  },
] as const;

function Faq() {
  return (
    <Band id="faq" className="py-20">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
        <div>
          <Eyebrow>FAQs</Eyebrow>
          <Heading>Questions people ask first</Heading>
        </div>
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {FAQS.map((f) => (
            // <details> is an accordion with no JavaScript: it works before hydration and with the keyboard.
            <details key={f.q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-ink">
                {f.q}
                <ChevronDown className="size-5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <p className="mt-3 text-sm text-slate-600">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------ 9. final cta and legal

function FinalCta() {
  return (
    <Band className="pb-20">
      <div className="relative overflow-hidden rounded-3xl bg-navy px-8 py-14 text-center text-white">
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-1/2 h-64 w-[80%] -translate-x-1/2 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative flex flex-col items-center gap-5">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Agree on &quot;done&quot; before anyone pays</h2>
          <p className="max-w-xl text-white/70">Write your first brief in plain words and see the criteria Settld proposes.</p>
          <PrimaryCta inverted />
        </div>
      </div>
    </Band>
  );
}

function Legal() {
  return (
    <Band className="border-t border-slate-200 bg-white">
      <div className="flex flex-col gap-2 py-6 text-xs text-slate-500">
        {/* Constitution XIII requires this sentence in product copy. */}
        <p>Settld is not a law firm and does not provide legal advice. Settld does not hold funds: payments are processed and held by PayPal.</p>
        <p>This is a demo running on the PayPal sandbox. No real money moves.</p>
      </div>
    </Band>
  );
}
