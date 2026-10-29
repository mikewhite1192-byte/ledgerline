import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardBody } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Term } from "@/components/app/term";
import { Day, Facts, RecordLink } from "@/components/invoices/cells";
import { lineKindLabel } from "@/lib/format/labels";
import { QUEUE_REASON_LABELS } from "@/lib/invoices/labels";
import { readLoadRecord } from "@/lib/invoices/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

// One load, as the invoice queue sees it: its fields, extra charges and state miles, its invoice if
// it has one, and what the carrier's rate rules would bill for it today.
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
              { label: "Route", value: l.lane },
              { label: "Picked up", value: <Day value={l.pickupOn} /> },
              { label: "Delivered", value: <Day value={l.deliveredOn} /> },
              { label: "Loaded miles", term: "loaded-miles", value: l.loadedMiles.toLocaleString("en-US") },
              { label: "Empty miles", term: "empty-miles", value: l.emptyMiles.toLocaleString("en-US") },
              {
                label: "Linehaul",
                term: "linehaul",
                value: l.linehaulCents === null ? "No rate" : <Money cents={l.linehaulCents} tone="plain" />,
              },
              { label: "Fuel surcharge", term: "fuel-surcharge", value: <Money cents={l.fuelSurchargeCents} tone="plain" /> },
              {
                label: "Invoice",
                value: l.invoice ? (
                  <RecordLink table="invoices" id={l.invoice.id}>{l.invoice.invoiceNumber}</RecordLink>
                ) : (
                  "Not invoiced yet"
                ),
              },
            ]}
          />
        </CardBody>
      </Card>
      {l.engine.ok ? (
        <DataTable
          caption="What this load would bill today, from your rate rules"
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
      {/* A paystub's extra-pay line links here (through /records/load_accessorials/[id]). */}
      <div id="extra-charges" className="scroll-mt-20">
        <DataTable
          caption="Extra charges"
          rows={l.accessorials}
          rowKey={(r) => r.id}
          empty={{ title: "No extra charges on this load" }}
          columns={[
            { key: "kind", header: <Term id="extra-charges">Charge</Term>, cell: (r) => lineKindLabel(r.kind) },
            { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
          ]}
        />
      </div>
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
