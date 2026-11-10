import Link from "next/link";
import { publishContract, unpublishContract } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { formatDate } from "@/lib/dates";
import type { ListingState } from "@/lib/open-project";

// ADR-0018. Publishing is explicit: a draft never becomes visible because nobody was invited.
export function PublishSection({
  contractId,
  version,
  state,
  publishedUntil,
  lowVerifiabilityCount,
}: {
  contractId: string;
  version: number;
  state: ListingState;
  publishedUntil: string | null;
  lowVerifiabilityCount: number;
}) {
  if (state === "OVERDUE") {
    return (
      <ActionForm action={unpublishContract} submitLabel="Withdraw project" variant="outline" className="border-t border-slate-100 pt-4">
        <input type="hidden" name="contractId" value={contractId} />
        <p className="text-sm font-semibold text-amber-900">Sellers can no longer see this project</p>
        <p className="mt-1 text-sm text-slate-600">A milestone&apos;s due date has passed. Withdraw the project, update the dates, and publish it again.</p>
      </ActionForm>
    );
  }
  if (state === "OPEN" && publishedUntil !== null) {
    return (
      <ActionForm action={unpublishContract} submitLabel="Withdraw project" variant="outline" className="border-t border-slate-100 pt-4">
        <input type="hidden" name="contractId" value={contractId} />
        <p className="text-sm font-semibold text-ink">This project is open</p>
        <p className="mt-1 text-sm text-slate-600">
          Any seller with PayPal ready can take it until {formatDate(publishedUntil.slice(0, 10))}, and the agreement locks at that moment. No money moves until you fund it.{" "}
          <Link href={`/contracts/open/${contractId}`} className="underline underline-offset-2 hover:text-ink">
            See how it looks
          </Link>
        </p>
      </ActionForm>
    );
  }
  return (
    <ActionForm action={publishContract} submitLabel="Publish project" variant="outline" className="border-t border-slate-100 pt-4">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="version" value={version} />
      <p className="text-sm font-semibold text-ink">{state === "EXPIRED" ? "The listing expired" : "Or publish it, if you have no one in mind"}</p>
      <p className="mt-1 text-sm text-slate-600">
        The first seller who accepts these exact terms gets the project. It stays open for 30 days, and no money moves until you fund it. If it does not work out, you can cancel before funding.
      </p>
      <p className="mt-1 text-sm text-amber-900">Every signed-in user can read the whole contract, including any address used in its checks. Remove anything private first.</p>
      {lowVerifiabilityCount > 0 && (
        <label className="mt-2 flex items-start gap-2 text-sm text-amber-900">
          <input type="checkbox" name="acknowledgeLowVerifiability" required className="mt-1" />
          {lowVerifiabilityCount} milestone(s) depend mostly on human review. I accept that they cannot be verified automatically.
        </label>
      )}
    </ActionForm>
  );
}
