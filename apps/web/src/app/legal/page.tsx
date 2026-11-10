import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Privacy & legal",
  description: "How Settld handles your data, and what Settld is and is not.",
};

// Constitution XIII: the AI never invents legal clauses. So this page only describes what the
// product does and has no binding terms (no liability limits, arbitration or governing law).
// Binding terms belong in a lawyer-reviewed template. Keep it true when the data flows change.

// Shown as is until the owner fills them in: an invented company name or mailbox would look
// real and be wrong, and a request sent to it would be lost.
const OPERATOR = "[operator legal name]";
const CONTACT = "[privacy contact email]";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight text-ink">
        {title}
      </h2>
      <div className="mt-2 space-y-3 text-sm leading-6 text-slate-600">{children}</div>
    </section>
  );
}

function Items({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export default function LegalPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Privacy & legal" description="Last updated: November 5, 2026" />

      <Card className="border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        <strong>Demo environment.</strong> Settld currently runs on PayPal sandbox, so no real money moves. This
        page is general information and has not yet been reviewed by a lawyer.
      </Card>

      <Card className="space-y-8 p-6 sm:p-8">
        <Section id="legal-notice" title="Legal notice">
          <p>
            <strong className="text-ink">Settld is not a law firm and does not provide legal advice.</strong> Nothing
            on this site, including AI output, is legal, financial or tax advice. Consult a qualified professional
            for those questions.
          </p>
          <Items
            items={[
              <>
                <strong className="text-ink">Settld does not hold your money.</strong> Funds stay with PayPal until
                they are released or the authorization ends. Settld is not a bank or an escrow service, and
                PayPal&apos;s own terms apply to your PayPal account and payments.
              </>,
              <>
                <strong className="text-ink">The agreement is operational.</strong> Settld records milestones,
                criteria, amounts, deadlines and splits. Any legal contract between the parties is their own
                responsibility.
              </>,
              <>
                <strong className="text-ink">AI can be wrong.</strong> AI helps draft criteria and check evidence. A
                check can be mistaken or uncertain, so review the results that affect your payment.
              </>,
              <>
                <strong className="text-ink">Disputes.</strong> Settld offers an objection process. It is a product
                feature, and it does not replace a court or any right you have under the law.
              </>,
            ]}
          />
        </Section>

        <Section id="data-we-collect" title="Data we collect">
          <Items
            items={[
              <>
                <strong className="text-ink">Account:</strong> email, name, country, account type, business name, roles
                and language.
              </>,
              <>
                <strong className="text-ink">Professional profile, if you add one:</strong> headline, professions,
                skills, bio and link. It appears in the directory only if you choose that.
              </>,
              <>
                <strong className="text-ink">PayPal connection:</strong> your PayPal email and merchant or payer ID. We
                never receive your PayPal password or card numbers.
              </>,
              <>
                <strong className="text-ink">Contracts:</strong> milestones, criteria, invitations, deliveries,
                evidence, verification results, objections and payment records.
              </>,
            ]}
          />
        </Section>

        <Section id="how-we-use-data" title="How we use data">
          <p>
            We use this data to run your contracts, check deliveries, release payments, send notifications and keep the
            record of what happened. Settld reads source code only to verify work, and keeps it only as part of
            evidence snapshots. We do not sell your data and this site has no advertising or analytics trackers.
          </p>
        </Section>

        <Section id="service-providers" title="Service providers">
          <p>These providers process data for Settld, and may do so in the United States and other countries:</p>
          <Items
            items={[
              <>
                <strong className="text-ink">Clerk:</strong> sign-in and session management.
              </>,
              <>
                <strong className="text-ink">PayPal:</strong> account connection and payments.
              </>,
              <>
                <strong className="text-ink">Anthropic:</strong> AI drafting of criteria and AI checks of evidence. The
                content of the criteria and evidence involved is sent to its Claude models.
              </>,
              <>
                <strong className="text-ink">Vercel and Amazon Web Services:</strong> hosting of the website, API and
                database.
              </>,
              <>
                <strong className="text-ink">Our email provider:</strong> delivery of notifications.
              </>,
            ]}
          />
        </Section>

        <Section id="sharing" title="Who can see what">
          <p>
            The parties to a contract can see its timeline and receipts, within the limits of their role. A reviewer
            assigned to an objection can see what is needed to decide it. Otherwise we share data only with the
            providers above, or when the law requires it.
          </p>
        </Section>

        <Section id="cookies" title="Cookies">
          <p>
            We use only the cookies needed to keep you signed in, which Clerk sets. PayPal sets its own cookies on its
            pages.
          </p>
        </Section>

        <Section id="retention-and-rights" title="Retention and your choices">
          <p>
            We keep data while your account or contracts need it. You can ask us to export or delete your data. Some
            records may have to stay, because the audit log and payment ledger are append-only and both parties rely on
            them. We will tell you if that applies to your request.
          </p>
          <p>
            The law where you live may give you other rights. To make a request, write to {CONTACT}.
          </p>
        </Section>

        <Section id="security" title="Security">
          <p>
            Connections are encrypted with HTTPS and services can reach only the data they need. No system is perfectly
            secure, so please avoid putting passwords or other secrets in deliveries or evidence.
          </p>
        </Section>

        <Section id="contact" title="Contact">
          <p>
            Settld is operated by {OPERATOR}. Questions about this page: {CONTACT}.
          </p>
        </Section>
      </Card>
    </div>
  );
}
