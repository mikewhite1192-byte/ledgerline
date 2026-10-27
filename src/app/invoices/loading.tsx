import { LoadingState } from "@/components/app/states";

export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6 md:px-6 md:py-8">
      <LoadingState label="Loading invoices" rows={4} />
    </main>
  );
}
