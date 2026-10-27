import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardBody } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Day, Facts, RecordLink } from "@/components/invoices/cells";
import { lineKindLabel } from "@/lib/format/labels";
import { QUEUE_REASON_LABELS } from "@/lib/invoices/labels";
import { readLoadRecord } from "@/lib/invoices/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

// One load, as the invoice queue sees it: its fields, accessorials and state miles, its invoice if
// it has one, and what the rules engine would invoice for it now.
export default async function LoadRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, (q, rid) => readLoadRecord(q, rid));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/invoices" title="Load">
        <PageHeader title="Load" />
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const l = page.record;
  return (
    <SignedInPage tenant={page.shell} current="/invoices" title={`Load ${l.loadNumber}`}>
      <PageHeader
        title={`Load ${l.loadNumber}`}
        description={<RecordLink table="customers" id={l.customerId}>{l.customerName}</RecordLink>}
        actions={<StatusBadge status={l.status} />}
      />
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Lane", value: l.lane },
              { label: "Picked up", value: <Day value={l.pickupOn} /> },
              { label: "Delivered", value: <Day value={l.deliveredOn} /> },
              { label: "Loaded miles", value: l.loadedMiles.toLocaleString("en-US") },
              { label: "Empty miles", value: l.emptyMiles.toLocaleString("en-US") },
              {
                label: "Linehaul rate",
                value: l.linehaulCents === null ? "No rate" : <Money cents={l.linehaulCents} tone="plain" />,
              },
              { label: "Fuel surcharge", value: <Money cents={l.fuelSurchargeCents} tone="plain" /> },
              {
                label: "Invoice",
                value: l.invoice ? (
                  <RecordLink table="invoices" id={l.invoice.id}>{l.invoice.invoiceNumber}</RecordLink>
                ) : (
                  "Not invoiced"
                ),
              },
            ]}
          />
        </CardBody>
      </Card>
      {l.engine.ok ? (
        <DataTable
          caption="What the rules engine would invoice now"
          rows={l.engine.lines}
          rowKey={(r) => r.kind}
          columns={[
            { key: "line", header: "Line", cell: (r) => r.label },
            { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
          ]}
        />
      ) : (
        <InlineAlert tone="warning">Cannot be invoiced: {QUEUE_REASON_LABELS[l.engine.reason]}.</InlineAlert>
      )}
      <DataTable
        caption="Accessorials"
        rows={l.accessorials}
        rowKey={(r) => r.id}
        empty={{ title: "No accessorials on this load" }}
        columns={[
          { key: "kind", header: "Kind", cell: (r) => lineKindLabel(r.kind) },
          { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
        ]}
      />
      <DataTable
        caption="Miles by state"
        rows={l.stateMiles}
        rowKey={(r) => r.state}
        empty={{ title: "No state miles on this load" }}
        columns={[
          { key: "state", header: "State", cell: (r) => r.state },
          { key: "miles", header: "Miles", align: "right", cell: (r) => r.miles.toLocaleString("en-US") },
        ]}
      />
    </SignedInPage>
  );
}
