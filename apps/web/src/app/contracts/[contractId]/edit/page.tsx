import Link from "next/link";
import { DraftForm } from "@/components/draft-form";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";

// suggestCriteria waits for a model. Core API gives up at 55 s, so the person gets an answer rather
// than a cut connection.
export const maxDuration = 60;

export default async function EditContractPage({ params }: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await params;
  await requireOnboardedMe(`/contracts/${contractId}/edit`);
  const client = await api();
  const contract = dataOrThrow(await client.GET("/contracts/{contractId}", { params: { path: { contractId } } }));
  const v = contract.currentVersion;

  if (v.status === "LOCKED") {
    return (
      <p className="text-sm">
        Version {v.version} is agreed and cannot be edited.{" "}
        <Link className="underline" href={`/contracts/${contractId}`}>
          Back
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Edit {contract.title}</h1>
      {/* version is the If-Match: the number this form was rendered from. */}
      <DraftForm mode="edit" contractId={contractId} version={v.version} snapshot={v.snapshot} supersedes={v.status === "PENDING_APPROVAL"} />
    </div>
  );
}
