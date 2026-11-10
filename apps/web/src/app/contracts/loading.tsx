import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading contracts">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="space-y-3 p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-20" />
          </Card>
        ))}
      </div>
      <Card className="divide-y divide-slate-100">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between gap-4 p-5">
            <div className="space-y-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-72" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        ))}
      </Card>
    </div>
  );
}
