// The payments ledger (ADR-0017): every money fact of this person's contracts, across contracts.
// Reads only. The range is in the URL and goes to Core API; everything else (views, column filters,
// search) happens in the grid, over rows this person is already allowed to see.
import type { Metadata } from "next";
import Form from "next/form";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { LedgerLoader } from "@/components/payments/ledger-loader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { todayIso } from "@/lib/dates";
import { parseLedgerRange } from "@/lib/ledger";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const range = parseLedgerRange(await searchParams, todayIso());
  await requireOnboardedMe(`/payments?from=${range.from}&to=${range.to}`);
  const { items, truncated } = dataOrThrow(await (await api()).GET("/payments", { params: { query: range } }));

  return (
    <div className="space-y-6">
      <PageHeader title="Payments" description="Every payment and return on your contracts, with the PayPal id and the criteria behind it." />
      <AutoRefresh />
      {/* key: after a search, the fields must show the URL's values, not what React kept from before.
          Prefixed because the ledger below is a sibling keyed by the same range: two siblings with one
          key leave React unable to tell them apart, and it kept the old form next to the new one. */}
      <Form key={`form-${range.from}|${range.to}`} action="/payments" className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-600">
          From
          <Input type="date" name="from" defaultValue={range.from} className="mt-1 w-auto" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          To
          <Input type="date" name="to" defaultValue={range.to} className="mt-1 w-auto" />
        </label>
        <Button type="submit" variant="outline">
          Apply dates
        </Button>
        <p className="pb-2 text-xs text-slate-500">Dates are in UTC.</p>
      </Form>
      {/* key: other dates are another ledger. Kept alive, their rows would all flash as new payments. */}
      <LedgerLoader key={`ledger-${range.from}|${range.to}`} items={items} truncated={truncated} />
    </div>
  );
}
