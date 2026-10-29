import { LoadingState } from "@/components/app/states";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// While Friday's figures are read: the verdict, six tiles (two up on a phone) and the tables keep
// their shape.
export default function Loading() {
  return (
    <main className="mx-auto grid w-full max-w-[960px] gap-6 px-4 py-6 md:px-6 md:py-8">
      <Card className="grid gap-2 px-4 py-4 sm:px-5">
        <Skeleton className="h-6 w-3/5" />
        <Skeleton className="w-2/5" />
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i} className="grid gap-2 px-4 py-4 sm:px-5">
            <Skeleton className="w-1/2" />
            <Skeleton className="h-7 w-3/4" />
          </Card>
        ))}
      </div>
      <LoadingState label="Reading Friday's figures" rows={4} />
    </main>
  );
}
