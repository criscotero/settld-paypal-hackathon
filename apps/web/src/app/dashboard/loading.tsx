import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading dashboard">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="space-y-3 p-5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-24" />
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="divide-y divide-slate-100">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 p-5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-72" />
              </div>
            </div>
          ))}
        </Card>
        <Card className="space-y-4 p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-10 w-full" />
        </Card>
      </div>
    </div>
  );
}
