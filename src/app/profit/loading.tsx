import { LoadingState } from "@/components/app/states";

// Holds the page's place while its reads run.
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-10">
      <LoadingState label="Loading last week's figures" rows={6} />
    </main>
  );
}
