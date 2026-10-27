import { flags } from "@/config/flags";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { Card, CardBody } from "@/components/ui/card";
import { Day, Facts, RecordLink } from "@/components/invoices/cells";
import { LedgerTable } from "@/components/invoices/ledger-table";
import { PostButton } from "@/components/invoices/post-button";
import { readPaymentRecord } from "@/lib/invoices/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

const METHOD_WORDS: Readonly<Record<string, string>> = { check: "Check", ach: "ACH", wire: "Wire" };

// One customer payment: what came in, where it was applied, the credit left, and every attempt to
// post it. Posting waits until each invoice it applies to is in QuickBooks.
export default async function PaymentRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, (q, rid) => readPaymentRecord(q, rid));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/customer-payments/new" title="Payment">
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const p = page.record;
  const confirmed = p.posted || p.ledger.some((r) => r.state === "confirmed");
  const canPost = flags.customerPaymentsEnabled && !confirmed && p.invoicesPosted;
  return (
    <SignedInPage tenant={page.shell} current="/customer-payments/new" title={`Payment ${p.paymentRef}`}>
      <PageHeader
        title={`Payment ${p.paymentRef}`}
        description={<RecordLink table="customers" id={p.customerId}>{p.customerName}</RecordLink>}
      />
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Amount", value: <Money cents={p.amountCents} tone="plain" /> },
              { label: "Applied", value: <Money cents={p.appliedCents} tone="plain" /> },
              { label: "Credit left", value: <Money cents={p.creditCents} tone="plain" /> },
              { label: "Received", value: <Day value={p.receivedOn} /> },
              { label: "Method", value: METHOD_WORDS[p.method] ?? p.method },
              { label: "QuickBooks", value: p.qboTail ? `Posted, id ending ${p.qboTail}` : "Not posted" },
            ]}
          />
        </CardBody>
      </Card>
      {canPost ? <PostButton url={`/api/customer-payments/${encodeURIComponent(p.id)}/post`} /> : null}
      {!confirmed && !p.invoicesPosted ? (
        <p className="text-body text-foreground-2">
          Posting waits until every invoice this payment applies to is posted to QuickBooks.
        </p>
      ) : null}
      <DataTable
        caption="Applied to"
        rows={p.applications}
        rowKey={(a) => a.id}
        empty={{ title: "Not applied to any invoice", body: "The whole payment is credit on the customer." }}
        columns={[
          {
            key: "invoice",
            header: "Invoice",
            cell: (a) => <RecordLink table="invoices" id={a.invoiceId}>{a.invoiceNumber}</RecordLink>,
          },
          { key: "amount", header: "Applied", align: "right", cell: (a) => <Money cents={a.amountCents} tone="plain" /> },
        ]}
      />
      <LedgerTable rows={p.ledger} timezone={page.shell.timezone} />
    </SignedInPage>
  );
}
