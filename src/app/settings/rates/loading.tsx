import { LoadingState } from "@/components/app/states";

// While the rates are read: the page keeps its shape.
export default function Loading() {
  return (
    <div className="mx-auto grid w-full max-w-[960px] gap-6">
      <LoadingState label="Reading the fuel and tax rates" rows={5} />
    </div>
  );
}
