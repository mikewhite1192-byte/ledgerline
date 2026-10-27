import Link from "next/link";
import { flags } from "@/config/flags";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { StatCard } from "@/components/app/stat-card";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { BUCKET_WORDS, Day, Facts, RecordLink } from "@/components/invoices/cells";
import { formatCents } from "@/lib/format/money";
import { AGING_BUCKETS } from "@/lib/rules-engine";
import { readCustomerRecord } from "@/lib/invoices/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

const METHOD_WORDS: Readonly<Record<string, string>> = { check: "Check", ach: "ACH", wire: "Wire" };

// One customer: what they owe by age, their invoices, their payments and the credit they have.
export default async function CustomerRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, readCustomerRecord);
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="none" title="Customer">
        <PageHeader title="Customer" />
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const c = page.record;
  return (
    <SignedInPage tenant={page.shell} current="none" title={c.name}>
      <PageHeader
        title={c.name}
        description={`${c.code} · net ${c.termsDays} days`}
        actions={
          flags.customerPaymentsEnabled ? (
            <Link
              href={`/customer-payments/new?customer=${encodeURIComponent(c.id)}`}
              className={buttonVariants({ variant: "primary" })}
            >
              Record a payment
            </Link>
          ) : undefined
        }
      />
      <section aria-label="What this customer owes" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Owed" value={formatCents(c.agingTotalCents)} />
        {AGING_BUCKETS.map((b) => (
          <StatCard key={b} label={BUCKET_WORDS[b]} value={formatCents(c.aging?.[b] ?? 0)} />
        ))}
      </section>
      <p className="text-body text-foreground">
        Unapplied credit <Money cents={c.creditCents} tone="plain" />
      </p>
      {flags.invoicesEnabled && flags.invoiceReviewEnabled ? (
        <Card>
          <CardBody>
            <Facts
              items={[
                { label: "Requires delivery document", value: c.podRequired ? "Yes" : "No" },
                { label: "Billing address", value: c.billingDomain ? `At ${c.billingDomain}` : "None on file" },
              ]}
            />
          </CardBody>
        </Card>
      ) : null}
      <DataTable
        caption="Invoices"
        rows={c.invoices}
        rowKey={(r) => r.id}
        empty={{ title: "No invoices for this customer yet" }}
        columns={[
          { key: "number", header: "Invoice", cell: (r) => <RecordLink table="invoices" id={r.id}>{r.invoiceNumber}</RecordLink> },
          { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          { key: "balance", header: "Balance", align: "right", cell: (r) => <Money cents={r.balanceCents} tone="plain" /> },
          { key: "due", header: "Due", cell: (r) => <Day value={r.dueOn} /> },
          { key: "bucket", header: "Aging", cell: (r) => (r.bucket ? BUCKET_WORDS[r.bucket] : "") },
        ]}
      />
      <DataTable
        caption="Payments, newest first"
        rows={c.payments}
        rowKey={(r) => r.id}
        empty={{ title: "No payments from this customer yet" }}
        columns={[
          {
            key: "ref",
            header: "Payment",
            cell: (r) => <RecordLink table="customer_payments" id={r.id}>{r.paymentRef}</RecordLink>,
          },
          { key: "on", header: "Received", cell: (r) => <Day value={r.receivedOn} /> },
          { key: "method", header: "Method", cell: (r) => METHOD_WORDS[r.method] ?? r.method },
          { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
          { key: "credit", header: "Credit left", align: "right", cell: (r) => <Money cents={r.creditCents} tone="plain" /> },
        ]}
      />
    </SignedInPage>
  );
}
