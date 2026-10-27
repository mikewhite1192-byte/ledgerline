import { redirect } from "next/navigation";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

// A pay week is shown on the settlements screen; its record link lands there, on that week.
export default async function SettlementPeriodRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(isUuid(id) ? `/settlements?period=${encodeURIComponent(id.toLowerCase())}` : "/settlements");
}
