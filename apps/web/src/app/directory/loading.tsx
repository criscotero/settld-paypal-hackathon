import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function DirectoryLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16 w-full max-w-xl" />
      <Skeleton className="h-10 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-20 w-full" />
          </Card>
        ))}
      </div>
    </div>
  );
}
