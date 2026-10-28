import { LoadingState } from "@/components/app/states";

// Holds the page's place while its reads run.
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[720px] px-4 py-10">
      <LoadingState label="Loading late invoices" rows={4} />
    </main>
  );
}
