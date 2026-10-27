import { flags } from "@/config/flags";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Facts, RecordLink } from "@/components/invoices/cells";
import { ContinueBatch } from "@/components/settlements/continue-batch";
import { Card, CardBody } from "@/components/ui/card";
import { formatInstant } from "@/lib/format/dates";
import { readBatchRecord } from "@/lib/settlements/views";
import { readRecordPage } from "../../records/read-record";

export const dynamic = "force-dynamic";

const LEG = (state: string | null) => (state ? <StatusBadge status={state} /> : <span className="text-foreground-2">None</span>);

// One "Approve all clean" batch: the paystubs it approved and where each money leg stands.
// "Continue" sends what is left while the batch is still sending.
export default async function BatchRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, (q, batchId) => readBatchRecord(q, batchId));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/settlements" title="Batch">
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const b = page.record;
  const tz = page.shell.timezone;
  const canContinue =
    flags.settlementsEnabled && flags.batchApproveEnabled && (b.status === "confirmed" || b.status === "draining");
  return (
    <SignedInPage tenant={page.shell} current="/settlements" title="Approval batch">
      <PageHeader
        title="Approval batch"
        description={`${b.items.length} ${b.items.length === 1 ? "paystub" : "paystubs"} approved together`}
        actions={<StatusBadge status={b.status} />}
      />
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Total", value: <Money cents={b.totalCents} tone="plain" /> },
              { label: "Legs reserved", value: String(b.legsReserved) },
              { label: "Approved", value: formatInstant(b.createdAt, tz) },
              { label: "Finished", value: b.finishedAt ? formatInstant(b.finishedAt, tz) : "Not yet" },
            ]}
          />
        </CardBody>
      </Card>
      {canContinue ? <ContinueBatch batchId={b.id} /> : null}
      <DataTable
        caption="Paystubs in this batch"
        rows={b.items}
        rowKey={(i) => i.settlementId}
        columns={[
          {
            key: "driver",
            header: "Driver",
            wrap: true,
            cell: (i) => (
              <RecordLink table="settlements" id={i.settlementId}>
                {i.driverName} <span className="text-foreground-2">{i.driverCode}</span>
              </RecordLink>
            ),
          },
          { key: "net", header: "Net", align: "right", cell: (i) => <Money cents={i.netCents} tone="plain" /> },
          { key: "payout", header: "Payout", cell: (i) => LEG(i.legs.settlement_payout) },
          { key: "bill", header: "Bill", cell: (i) => LEG(i.legs.settlement_bill) },
          { key: "billPayment", header: "Bill payment", cell: (i) => LEG(i.legs.settlement_bill_payment) },
        ]}
      />
    </SignedInPage>
  );
}
