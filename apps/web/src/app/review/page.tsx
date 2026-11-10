import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReviewQueueLoader } from "@/components/grid/review-queue-loader";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { reviewRows } from "@/lib/review-queue";

export const metadata: Metadata = { title: "Objections to review" };

// Where a neutral reviewer works (ADR-0014). Core API decides who may see this and leaves out their
// own contracts; for anyone else the page does not exist.
export default async function ReviewPage() {
  await requireOnboardedMe("/review");
  const result = await (await api()).GET("/objections");
  if (result.response.status === 403) notFound();
  const { items } = dataOrThrow(result);
  return (
    <div className="space-y-6">
      <PageHeader title="Objections to review" description="The parties did not settle these. Read both sides and the delivery, and decide with a written reason." />
      {items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500">Nothing is waiting for a ruling.</Card>
      ) : (
        // ADR-0022, view 5. The wait is measured here, on the server, once per page load.
        <ReviewQueueLoader rows={reviewRows(items, new Date())} />
      )}
    </div>
  );
}
