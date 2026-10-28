import Link from "next/link";
import { notFound } from "next/navigation";
import { flags } from "@/config/flags";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { Day, Facts } from "@/components/invoices/cells";
import { Card, CardBody } from "@/components/ui/card";
import { BILL_CATEGORY_WORDS, BILL_STATUS_WORDS } from "@/lib/cash/labels";
import { readVendorBill } from "@/lib/cash/view";
import { formatLocalDate } from "@/lib/format/dates";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

// One bill the carrier owes a vendor: what, how much, when it is due, whether the vendor takes a
// later date, and where it stands. A bill moved from the Cash page says the new date.
export default async function VendorBillRecord({ params }: { params: Promise<{ id: string }> }) {
  if (!flags.cashFridayEnabled) notFound();
  const { id } = await params;
  const page = await readRecordPage(id, (q, rid) => readVendorBill(q, rid));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/cash" title="Bill">
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const b = page.record;
  const status =
    b.status === "deferred" && b.deferredTo
      ? `Moved to ${formatLocalDate(b.deferredTo)} after a person approved it on the Cash page`
      : b.status === "paid" && b.paidOn
        ? `Paid ${formatLocalDate(b.paidOn)}`
        : BILL_STATUS_WORDS[b.status];
  return (
    <SignedInPage tenant={page.shell} current="/cash" title={`Bill ${b.billRef}`}>
      <PageHeader
        title={`Bill ${b.billRef}`}
        description={
          <>
            {b.vendorName}.{" "}
            <Link href="/cash#bills" className="text-link underline-offset-4 hover:underline">
              Back to Cash
            </Link>
          </>
        }
      />
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Amount", value: <Money cents={b.amountCents} tone="plain" /> },
              { label: "For", value: BILL_CATEGORY_WORDS[b.category] },
              { label: "Due", value: <Day value={b.dueOn} /> },
              {
                label: "Can it move?",
                value: b.urgency === "flexible" ? "Yes, the vendor takes a later date" : "No, it must be paid on time",
              },
              { label: "Status", value: status },
            ]}
          />
        </CardBody>
      </Card>
    </SignedInPage>
  );
}
