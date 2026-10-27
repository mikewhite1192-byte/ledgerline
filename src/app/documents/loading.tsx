import { LoadingState } from "@/components/app/states";

// While the documents are read: the page keeps its shape.
export default function Loading() {
  return (
    <div className="mx-auto grid w-full max-w-[1080px] gap-6 px-4 py-6 md:px-6 md:py-8">
      <LoadingState label="Reading your documents" rows={6} />
    </div>
  );
}
