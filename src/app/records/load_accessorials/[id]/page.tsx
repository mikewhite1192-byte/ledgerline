import { redirect } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { readExtraChargeLoadId } from "@/lib/records/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

// An extra charge (detention, a lumper, a stop) is shown in its load's "Extra charges" table, so
// its record link lands there. One this carrier does not have shows the usual not-here state.
export default async function ExtraChargeRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, (q, rid) => readExtraChargeLoadId(q, rid));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/invoices" title="Extra charge">
        <PageHeader title="Extra charge" />
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  redirect(`/records/loads/${encodeURIComponent(page.record)}#extra-charges`);
}
