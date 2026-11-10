"use client";
import { ArrowLeft, ArrowRight, Briefcase, Check, CircleAlert, CircleCheck, Handshake, Landmark, ShoppingBag, User, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { applyDuringOnboarding } from "@/app/reviewer-actions";
import { SETTLER_BODY, SETTLER_NOTE, SETTLER_TITLE } from "@/components/reviewer-copy";
import { checkSellerConnect, saveProfessional, saveProfile, saveRoles, startBuyerLink, startSellerConnect } from "@/app/onboarding/actions";
import { EMPTY_PROFESSIONAL, ProfessionalFields } from "@/components/professional-fields";
import type { Professional } from "@/components/professional-fields";
import { ErrorBox } from "@/components/error-box";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { Schemas } from "@/lib/api-types";
import { isPaypalOutcome, onboardingPath, PAYPAL_CHANNEL } from "@/lib/paypal-return";
import { COUNTRY_CODES, countryName } from "@/lib/countries";
import type { ActionError } from "@/lib/problem";
import { cn } from "@/lib/utils";

type Me = Schemas["User"];
type Notice = { tone: "good" | "warn" | "bad"; text: string } | null;
type RoleChoice = "BUYER" | "SELLER" | "BOTH" | "COLLABORATOR";

const STEPS = ["Your role", "About you", "Connect PayPal", "Ready"] as const;
const STEP_INDEX = { ROLES: 0, PROFILE: 1, PAYPAL: 2, DONE: 3 } as const;

function roleChoiceOf(roles: Me["roles"]): RoleChoice | null {
  const buyer = roles.includes("BUYER");
  const seller = roles.includes("SELLER");
  if (roles.includes("COLLABORATOR") && !buyer && !seller) return "COLLABORATOR";
  return buyer && seller ? "BOTH" : buyer ? "BUYER" : seller ? "SELLER" : null;
}

// Sellers and collaborators are paid by PayPal and say what they do (ADR-0009).
const paidByPaypal = (roles: Me["roles"]) => roles.includes("SELLER") || roles.includes("COLLABORATOR");

// Onboarding as a carousel (ADR-0006): one decision per panel (constitution XII), each saved to
// Core API before moving on, so closing the tab resumes at the first unfinished step.
export function OnboardingWizard({ me, notice, next }: { me: Me; notice: Notice; next?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<number>(STEP_INDEX[me.onboarding.nextStep]);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  // Which connection is open in the PayPal tab, while this tab waits for it.
  const [waiting, setWaiting] = useState<"BUYER" | "SELLER" | null>(null);

  // The PayPal tab reports here when it is done (lib/paypal-return.ts). Replacing the URL
  // shows the same notice a same-tab return would, and refresh() reloads `me`.
  useEffect(() => {
    const channel = new BroadcastChannel(PAYPAL_CHANNEL);
    channel.onmessage = (e: MessageEvent<{ outcome?: unknown }>) => {
      if (!isPaypalOutcome(e.data.outcome)) return;
      setWaiting(null);
      router.replace(onboardingPath(e.data.outcome, next));
      router.refresh();
    };
    return () => {
      channel.close();
    };
  }, [router, next]);

  // Runs a save; on success refreshes `me` from the server and slides to the next panel.
  function save(action: () => Promise<ActionError | null>, next: number) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result !== null) {
        setError(result);
        return;
      }
      router.refresh();
      setStep(next);
    });
  }

  // PayPal opens in a new tab, so this one keeps the wizard where it was. The tab is opened
  // right in the click, before the await: browsers only allow a popup during the click itself,
  // and one opened after the server action returns is blocked. It starts blank and gets
  // PayPal's URL when the action answers. opener is cut so a PayPal page cannot navigate this
  // tab (reverse tabnabbing); the answer comes back over the channel instead. If the popup was
  // blocked anyway, PayPal runs here as before and the done page brings the browser back.
  function goToPaypal(kind: "BUYER" | "SELLER", action: () => Promise<{ url: string } | ActionError>) {
    setError(null);
    const tab = window.open("", "_blank");
    if (tab !== null) tab.opener = null;
    startTransition(async () => {
      const result = await action();
      if (!("url" in result)) {
        tab?.close();
        setError(result);
        return;
      }
      if (tab === null) {
        window.location.assign(result.url);
        return;
      }
      tab.location.href = result.url;
      setWaiting(kind);
    });
  }

  // "I finished on PayPal": for when the PayPal tab never came back to Settld. For a seller it
  // asks Core API, which asks PayPal; a buyer's link only exists once the callback ran, so a
  // refresh is all there is to check.
  function checkPaypal(kind: "BUYER" | "SELLER") {
    setError(null);
    startTransition(async () => {
      if (kind === "SELLER") router.replace(onboardingPath(await checkSellerConnect(), next));
      setWaiting(null);
      router.refresh();
    });
  }

  const furthest = STEP_INDEX[me.onboarding.nextStep];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 py-4">
      <header className="text-center">
        <p className="text-sm font-semibold tracking-wide text-primary uppercase">Welcome to Settld</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-navy">Set up your account</h1>
        <p className="mt-2 text-slate-600">Three short steps, then you can start your first contract.</p>
      </header>

      <Stepper current={step} furthest={furthest} onJump={setStep} />

      {notice !== null && <NoticeBanner notice={notice} />}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_8px_30px_rgba(16,32,47,0.06)]">
        {/* The track slides; every panel is full width. Panels off screen are inert, so the
            keyboard and screen readers only ever reach the current step. */}
        <div className="flex items-start transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `translateX(-${(step * 100).toString()}%)` }}>
          <Panel active={step === 0}>
            <RoleStep initial={roleChoiceOf(me.roles)} pending={pending} error={step === 0 ? error : null} applied={me.reviewerApplication != null} onSave={(choice, settler) => {
                // Roles first: they decide the rest of the wizard, and applying grants nothing.
                save(async () => {
                  const saved = await saveRoles(choice === "BOTH" ? ["BUYER", "SELLER"] : [choice]);
                  return saved === null && settler ? applyDuringOnboarding() : saved;
                }, 1);
              }} />
          </Panel>
          <Panel active={step === 1}>
            <ProfileStep me={me} pending={pending} error={step === 1 ? error : null} onBack={() => {
                setStep(0);
              }}
              onSave={(p, professional) => {
                save(async () => (await saveProfile(p)) ?? (professional === null ? null : await saveProfessional(professional)), 2);
              }} />
          </Panel>
          <Panel active={step === 2}>
            <PaypalStep
              me={me}
              pending={pending}
              error={step === 2 ? error : null}
              onBack={() => {
                setStep(1);
              }}
              waiting={waiting}
              onCheck={checkPaypal}
              onBuyer={() => {
                goToPaypal("BUYER", startBuyerLink);
              }}
              onSeller={() => {
                goToPaypal("SELLER", () => startSellerConnect(crypto.randomUUID()));
              }}
              onContinue={() => {
                setStep(3);
              }}
            />
          </Panel>
          <Panel active={step === 3}>
            <ReadyStep me={me} next={next} />
          </Panel>
        </div>
      </div>

      <p className="text-center text-xs text-slate-500">Settld is not a law firm and does not provide legal advice. Settld never holds your money: PayPal does.</p>
    </div>
  );
}

// ---------------------------------------------------------------- frame

function Stepper({ current, furthest, onJump }: { current: number; furthest: number; onJump: (i: number) => void }) {
  return (
    <ol className="flex items-center justify-between gap-2" aria-label="Onboarding progress">
      {STEPS.map((label, i) => {
        const done = i < furthest;
        const here = i === current;
        // You can go back to any step you reached, never jump ahead of the first unfinished one.
        const reachable = i <= furthest && i !== 3;
        return (
          <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => {
                onJump(i);
              }}
              aria-current={here ? "step" : undefined}
              className={cn("flex items-center gap-2 rounded-full text-left", reachable && "cursor-pointer")}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ring-2 transition-colors",
                  done ? "bg-primary text-white ring-primary" : here ? "bg-white text-primary ring-primary" : "bg-white text-slate-400 ring-slate-200",
                )}
              >
                {done ? <Check className="size-4" aria-hidden /> : i + 1}
              </span>
              <span className={cn("hidden text-sm font-medium sm:inline", here ? "text-ink" : "text-slate-500")}>{label}</span>
            </button>
            {i < STEPS.length - 1 && <span aria-hidden className={cn("h-0.5 flex-1 rounded", i < furthest ? "bg-primary" : "bg-slate-200")} />}
          </li>
        );
      })}
    </ol>
  );
}

function Panel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    // Off-screen panels collapse to zero height, so the card fits the current step instead of
    // the tallest one.
    <section className={cn("w-full shrink-0 p-6 sm:p-10", !active && "h-0 overflow-hidden")} aria-hidden={!active} inert={!active}>
      {children}
    </section>
  );
}

function StepTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-bold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
    </div>
  );
}

function NoticeBanner({ notice }: { notice: NonNullable<Notice> }) {
  const tone = { good: "border-emerald-200 bg-emerald-50 text-emerald-900", warn: "border-amber-200 bg-amber-50 text-amber-900", bad: "border-red-200 bg-red-50 text-red-900" }[notice.tone];
  const Icon = notice.tone === "good" ? CircleCheck : CircleAlert;
  return (
    <div role="status" className={cn("flex items-start gap-3 rounded-xl border p-4 text-sm", tone)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      {notice.text}
    </div>
  );
}

function Footer({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="mt-8 flex items-center justify-between gap-3 border-t border-slate-100 pt-6">
      {onBack === undefined ? (
        <span />
      ) : (
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden /> Back
        </Button>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- step 1: role

const ROLE_OPTIONS: { value: RoleChoice; title: string; body: string; icon: ReactNode }[] = [
  { value: "BUYER", title: "I want to hire", body: "Post jobs, fund them through PayPal and pay only for verified work.", icon: <ShoppingBag className="size-6" aria-hidden /> },
  { value: "SELLER", title: "I want to get paid", body: "Deliver work, prove it with checks and get paid for what passed.", icon: <Briefcase className="size-6" aria-hidden /> },
  { value: "BOTH", title: "Both", body: "Hire for some projects and deliver on others with one account.", icon: <Handshake className="size-6" aria-hidden /> },
  { value: "COLLABORATOR", title: "I join teams", body: "Work on other sellers' contracts and get your share of each payment, paid by PayPal directly.", icon: <Users className="size-6" aria-hidden /> },
];

function RoleStep({ initial, pending, error, applied, onSave }: { initial: RoleChoice | null; pending: boolean; error: ActionError | null; applied: boolean; onSave: (choice: RoleChoice, settler: boolean) => void }) {
  const [choice, setChoice] = useState<RoleChoice | null>(initial);
  const [settler, setSettler] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (choice !== null) onSave(choice, settler && !applied);
      }}
    >
      <StepTitle title="How will you use Settld?" subtitle="This decides which PayPal connection you need. You choose it once." />
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Role</legend>
        {ROLE_OPTIONS.map((o) => {
          const selected = choice === o.value;
          return (
            <label
              key={o.value}
              className={cn(
                "relative flex cursor-pointer flex-col gap-3 rounded-xl border-2 p-5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                selected ? "border-primary bg-accent-soft" : "border-slate-200 hover:border-slate-300",
              )}
            >
              <input type="radio" name="role" value={o.value} checked={selected} onChange={() => {
                  setChoice(o.value);
                }} className="sr-only" />
              <span className={cn("flex size-11 items-center justify-center rounded-lg", selected ? "bg-primary text-white" : "bg-slate-100 text-navy")}>{o.icon}</span>
              <span className="font-bold text-ink">{o.title}</span>
              <span className="text-sm text-slate-600">{o.body}</span>
              {selected && <CircleCheck className="absolute top-4 right-4 size-5 text-primary" aria-hidden />}
            </label>
          );
        })}
      </fieldset>
      {/* Not one more role: it adds to whichever one is chosen, and it grants nothing by itself. */}
      {applied ? (
        <p className="mt-4 rounded-xl border border-slate-200 p-4 text-sm text-slate-600">We received your application to be a Settler. See its status on your profile.</p>
      ) : (
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm">
          <input type="checkbox" checked={settler} onChange={(e) => { setSettler(e.target.checked); }} className="mt-1" />
          <span>
            <span className="font-bold text-ink">{SETTLER_TITLE}</span>
            <span className="mt-1 block text-slate-600">{SETTLER_BODY}</span>
            <span className="mt-1 block text-slate-500">{SETTLER_NOTE} You still choose how you use Settld above.</span>
          </span>
        </label>
      )}
      <ErrorBox error={error} />
      <Footer>
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={choice === null}>
          Continue <ArrowRight aria-hidden />
        </Button>
      </Footer>
    </form>
  );
}

// ---------------------------------------------------------------- step 2: about you

function ProfileStep({
  me,
  pending,
  error,
  onBack,
  onSave,
}: {
  me: Me;
  pending: boolean;
  error: ActionError | null;
  onBack: () => void;
  onSave: (p: Schemas["ProfileInput"], professional: Professional | null) => void;
}) {
  const [accountType, setAccountType] = useState<"INDIVIDUAL" | "BUSINESS">(me.profile.accountType ?? "INDIVIDUAL");
  const [locale, setLocale] = useState<"en" | "es">(me.locale);
  const [professional, setProfessional] = useState<Professional>(me.professional ?? EMPTY_PROFESSIONAL);
  const withProfessional = paidByPaypal(me.roles);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const text = (name: string) => {
          const v = fd.get(name);
          return typeof v === "string" ? v.trim() : "";
        };
        onSave({
          fullName: text("fullName"),
          displayName: text("displayName"),
          country: text("country"),
          locale,
          accountType,
          businessName: accountType === "BUSINESS" ? text("businessName") : null,
          acceptTerms: true,
        }, withProfessional ? professional : null);
      }}
    >
      <StepTitle title="Tell us about you" subtitle="Only what contracts and receipts need. PayPal verifies your identity; Settld never asks for documents." />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Full name" hint="As it appears on contracts and receipts.">
          <Input name="fullName" required minLength={2} maxLength={120} autoComplete="name" defaultValue={me.profile.fullName ?? ""} />
        </Field>
        <Field label="Display name" hint="What the other party sees.">
          <Input name="displayName" required minLength={2} maxLength={60} autoComplete="nickname" defaultValue={me.displayName} />
        </Field>
        <Field label="Country">
          <Select name="country" required defaultValue={me.profile.country ?? ""}>
            <option value="" disabled>
              Choose your country
            </option>
            {COUNTRY_CODES.map((c) => (
              <option key={c} value={c}>
                {countryName(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Language" group>
          <Segmented value={locale} onChange={setLocale} options={[{ value: "en", label: "English" }, { value: "es", label: "Español" }]} />
        </Field>
        <Field label="Account type" group className="sm:col-span-2">
          <Segmented
            value={accountType}
            onChange={setAccountType}
            options={[
              { value: "INDIVIDUAL", label: "Individual", icon: <User className="size-4" aria-hidden /> },
              { value: "BUSINESS", label: "Business", icon: <Briefcase className="size-4" aria-hidden /> },
            ]}
          />
        </Field>
        {accountType === "BUSINESS" && (
          <Field label="Business name" className="sm:col-span-2">
            <Input name="businessName" required minLength={2} maxLength={120} autoComplete="organization" defaultValue={me.profile.businessName ?? ""} />
          </Field>
        )}
      </div>
      {withProfessional && (
        <section className="mt-8 space-y-4 border-t border-slate-100 pt-6" aria-labelledby="what-you-do">
          <div>
            <h3 id="what-you-do" className="font-bold text-ink">
              What you do
            </h3>
            <p className="text-sm text-slate-500">Buyers and teammates see this on your contracts. You can change it later in your profile.</p>
          </div>
          <ProfessionalFields value={professional} onChange={setProfessional} />
        </section>
      )}
      <label className="mt-6 flex items-start gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-200">
        <input type="checkbox" name="acceptTerms" required defaultChecked={me.profile.termsAcceptedAt !== null} className="mt-0.5 size-4 accent-primary" />
        <span>
          I accept the Settld terms. I understand Settld is not a law firm and does not provide legal advice, and that PayPal, not Settld, holds and moves the money.
        </span>
      </label>
      <ErrorBox error={error} />
      <Footer onBack={onBack}>
        <Button type="submit" variant="primary" size="lg" loading={pending}>
          Continue <ArrowRight aria-hidden />
        </Button>
      </Footer>
    </form>
  );
}

function Field({ label, hint, group = false, className, children }: { label: string; hint?: string; group?: boolean; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {group ? (
        // A set of buttons is not one control: a <label> would hand its text to the first
        // button (announced as "Language English") and clicking the label would press it.
        <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
          <span id={id} className="text-sm font-medium text-slate-700">
            {label}
          </span>
          {children}
        </div>
      ) : (
        // Wrapping label for a single input: it becomes that input's name, no ids to keep in sync.
        <Label className="flex flex-col gap-1.5">
          {label}
          {children}
        </Label>
      )}
      {hint !== undefined && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[] }) {
  return (
    <div role="radiogroup" className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-slate-100 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => {
            onChange(o.value);
          }}
          className={cn(
            "flex h-8 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors",
            value === o.value ? "bg-white text-primary shadow-sm ring-1 ring-primary/40" : "text-slate-500 hover:text-ink",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- step 3: PayPal

function PaypalStep({
  me,
  pending,
  error,
  waiting,
  onCheck,
  onBack,
  onBuyer,
  onSeller,
  onContinue,
}: {
  me: Me;
  pending: boolean;
  error: ActionError | null;
  waiting: "BUYER" | "SELLER" | null;
  onCheck: (kind: "BUYER" | "SELLER") => void;
  onBack: () => void;
  onBuyer: () => void;
  onSeller: () => void;
  onContinue: () => void;
}) {
  const buyer = me.roles.includes("BUYER");
  const seller = paidByPaypal(me.roles);
  return (
    <div>
      <StepTitle title="Connect PayPal" subtitle="PayPal holds and moves the money; Settld only tells it when. Connecting is required for your role." />
      <div className="grid gap-4">
        {buyer && (
          <ConnectionCard
            title="Link your PayPal account"
            body="Sign in with PayPal so contracts you fund are tied to your account. Settld gets your PayPal id and email, never your password or cards."
            done={me.paypalLinked}
            doneText={me.paypalEmail === null || me.paypalEmail === undefined ? "Linked" : `Linked as ${me.paypalEmail}`}
            action="Log in with PayPal"
            pending={pending}
            onClick={onBuyer}
          />
        )}
        {seller && (
          <ConnectionCard
            title="Connect PayPal to get paid"
            body="Authorize Settld on PayPal so buyers' payments go straight to your PayPal account, minus any fee shown up front."
            done={me.paypalReady}
            doneText="Ready to receive payments"
            action="Connect with PayPal"
            pending={pending}
            onClick={onSeller}
          />
        )}
        {!buyer && !seller && <p className="text-sm text-slate-600">Choose a role first.</p>}
      </div>
      {waiting !== null && (
        <div role="status" className="mt-4 flex flex-col gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900 sm:flex-row sm:items-center">
          <p className="flex-1">PayPal is open in a new tab. Finish there; this page updates by itself when PayPal sends you back.</p>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              onCheck(waiting);
            }}
          >
            I finished on PayPal
          </Button>
        </div>
      )}
      {/* A seller who finished on PayPal in an earlier visit, but whose tab never came back. */}
      {waiting === null && seller && !me.paypalReady && (
        <p className="mt-3 text-sm text-slate-600">
          Already connected on PayPal?{" "}
          <button
            type="button"
            disabled={pending}
            className="font-semibold text-primary underline disabled:opacity-60"
            onClick={() => {
              onCheck("SELLER");
            }}
          >
            Check again
          </button>
        </p>
      )}
      <ErrorBox error={error} />
      <Footer onBack={onBack}>
        <Button type="button" variant="primary" size="lg" disabled={!me.onboarding.completed} onClick={onContinue}>
          Finish <ArrowRight aria-hidden />
        </Button>
      </Footer>
    </div>
  );
}

function ConnectionCard({ title, body, done, doneText, action, pending, onClick }: { title: string; body: string; done: boolean; doneText: string; action: string; pending: boolean; onClick: () => void }) {
  return (
    <div className={cn("flex flex-col gap-4 rounded-xl border p-5 sm:flex-row sm:items-center", done ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200")}>
      <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", done ? "bg-emerald-600 text-white" : "bg-[#003087] text-white")}>
        {done ? <Check className="size-5" aria-hidden /> : <Landmark className="size-5" aria-hidden />}
      </span>
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-bold text-ink">{title}</h3>
          <Badge tone={done ? "good" : "warn"} dot>
            {done ? "Connected" : "Required"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-slate-600">{done ? doneText : body}</p>
      </div>
      {!done && (
        // PayPal's own blue, so the button reads as "this takes you to PayPal".
        <button
          type="button"
          onClick={onClick}
          disabled={pending}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-[#0070ba] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#005ea6] disabled:opacity-60"
        >
          {action}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- step 4: ready

const ROLE_TEXT: Record<RoleChoice, string> = { BUYER: "buyer", SELLER: "seller", BOTH: "buyer and seller", COLLABORATOR: "collaborator" };

function ReadyStep({ me, next }: { me: Me; next?: string }) {
  const buyer = me.roles.includes("BUYER");
  const items = [
    `Role: ${ROLE_TEXT[roleChoiceOf(me.roles) ?? "SELLER"]}`,
    `Profile: ${me.profile.fullName ?? me.displayName}${me.profile.country === null ? "" : `, ${countryName(me.profile.country)}`}`,
    ...(buyer ? [`PayPal linked${me.paypalEmail ? ` (${me.paypalEmail})` : ""}`] : []),
    ...(paidByPaypal(me.roles) ? ["PayPal ready to receive payments"] : []),
  ];
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-accent-soft text-primary">
        <CircleCheck className="size-9" aria-hidden />
      </span>
      <div>
        <h2 className="text-2xl font-extrabold text-navy">You&apos;re all set</h2>
        <p className="mt-1 text-slate-600">Your account is ready. Here is what we saved.</p>
      </div>
      <ul className="w-full max-w-md divide-y divide-slate-100 rounded-xl border border-slate-200 text-left text-sm">
        {items.map((i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3">
            <Check className="size-4 shrink-0 text-primary" aria-hidden />
            {i}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-center gap-3">
        {next !== undefined && (
          <Link href={next} className={buttonVariants({ variant: "primary", size: "lg" })}>
            Continue where you were going <ArrowRight aria-hidden />
          </Link>
        )}
        <Link href="/dashboard" className={buttonVariants({ variant: next === undefined ? "primary" : "outline", size: "lg" })}>
          Go to your dashboard <ArrowRight aria-hidden />
        </Link>
        {buyer && (
          <Link href="/contracts/new" className={buttonVariants({ variant: "outline", size: "lg" })}>
            Start a contract
          </Link>
        )}
      </div>
    </div>
  );
}
