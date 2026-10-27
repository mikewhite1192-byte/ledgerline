import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardBody } from "@/components/ui/card";
import { BUCKET_WORDS, Day, Facts, RecordLink } from "@/components/invoices/cells";
import { CheckButton } from "@/components/invoices/check-button";
import { LedgerTable } from "@/components/invoices/ledger-table";
import { PostButton } from "@/components/invoices/post-button";
import { ReviewCard } from "@/components/invoices/review-card";
import { invoiceRecordActions, readInvoiceRecordPage } from "@/lib/invoices/record-page";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

// One invoice: who owes it, what it is for, what came in against it, and every attempt to post
// it to QuickBooks. "Post to QuickBooks" shows until a post is confirmed, for an invoice the
// invoice queue made (record-page.ts).
export default async function InvoiceRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, readInvoiceRecordPage);
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/invoices" title="Invoice">
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const inv = page.record.record;
  const review = page.record.review;
  const actions = invoiceRecordActions(page.record);
  return (
    <SignedInPage tenant={page.shell} current="/invoices" title={`Invoice ${inv.invoiceNumber}`}>
      <PageHeader
        title={inv.invoiceNumber}
        description={<RecordLink table="customers" id={inv.customerId}>{inv.customerName}</RecordLink>}
        actions={<StatusBadge status={inv.status} />}
      />
      {review ? (
        <ReviewCard view={review.view} roles={review.roles} today={page.today} timezone={page.shell.timezone} />
      ) : null}
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Amount", value: <Money cents={inv.amountCents} tone="plain" /> },
              { label: "Balance", value: <Money cents={inv.balanceCents} tone="plain" /> },
              { label: "Aging", value: inv.bucket ? BUCKET_WORDS[inv.bucket] : "Nothing owed" },
              { label: "Issued", value: <Day value={inv.issuedOn} /> },
              { label: "Due", value: <Day value={inv.dueOn} /> },
              {
                label: "Load",
                value:
                  inv.loadId && inv.loadNumber ? (
                    <RecordLink table="loads" id={inv.loadId}>{inv.loadNumber}</RecordLink>
                  ) : (
                    "Opening balance"
                  ),
              },
              { label: "QuickBooks", value: inv.qboTail ? `Posted, id ending ${inv.qboTail}` : "Not posted" },
            ]}
          />
        </CardBody>
      </Card>
      {actions.post ? <PostButton url={`/api/invoices/${encodeURIComponent(inv.id)}/post`} /> : null}
      {actions.check ? <CheckButton url={`/api/invoices/${encodeURIComponent(inv.id)}/reconcile`} /> : null}
      {inv.lines ? (
        <DataTable
          caption="Lines, from the rules engine"
          rows={inv.lines}
          rowKey={(l) => l.kind}
          columns={[
            { key: "line", header: "Line", cell: (l) => l.label },
            { key: "amount", header: "Amount", align: "right", cell: (l) => <Money cents={l.amountCents} tone="plain" /> },
          ]}
        />
      ) : null}
      <DataTable
        caption="Payments applied"
        rows={inv.applications}
        rowKey={(a) => a.id}
        empty={{ title: "No payments applied yet" }}
        columns={[
          {
            key: "ref",
            header: "Payment",
            cell: (a) => <RecordLink table="customer_payments" id={a.paymentId}>{a.paymentRef}</RecordLink>,
          },
          { key: "on", header: "Received", cell: (a) => <Day value={a.receivedOn || null} /> },
          { key: "amount", header: "Applied", align: "right", cell: (a) => <Money cents={a.amountCents} tone="plain" /> },
        ]}
      />
      <div id="posting-attempts">
        <LedgerTable rows={inv.ledger} timezone={page.shell.timezone} />
      </div>
    </SignedInPage>
  );
}
