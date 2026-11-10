import { Skeleton } from "@/components/ui/skeleton";

export default function PaymentsLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16 w-full max-w-xl" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-[560px] w-full" />
    </div>
  );
}
