import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DraftForm } from "@/components/draft-form";
import { PageHeader } from "@/components/page-header";
import { requireOnboardedMe } from "@/lib/api";

// suggestCriteria waits for a model. Core API gives up at 55 s, so the person gets an answer rather
// than a cut connection.
export const maxDuration = 60;

export const metadata: Metadata = { title: "New contract" };

export default async function NewContractPage() {
  await requireOnboardedMe("/contracts/new");
  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-slate-500">
        <Link href="/contracts" className="hover:text-ink">
          Contracts
        </Link>
        <ChevronRight className="size-4 text-slate-300" aria-hidden />
        <span className="font-medium text-ink" aria-current="page">
          New contract
        </span>
      </nav>
      <PageHeader title="New contract" description="Split the work into milestones. Each one is paid when its criteria are met." />
      <DraftForm mode="create" />
    </div>
  );
}
