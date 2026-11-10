import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading contract">
      <Skeleton className="h-4 w-48" />
      <Card className="space-y-6 p-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-8 w-80" />
          <Skeleton className="h-5 w-96" />
        </div>
        <div className="flex justify-between gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-2">
              <Skeleton className="size-9 rounded-full" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i} className="space-y-4 p-5">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
            </Card>
          ))}
        </div>
        <Card className="h-64 p-5">
          <Skeleton className="h-5 w-40" />
        </Card>
      </div>
    </div>
  );
}
