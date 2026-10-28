import type { ReactNode } from "react";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { lineDescription } from "@/components/app/paystub";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { Card, CardBody } from "@/components/ui/card";
import { Day, Facts, RecordLink } from "@/components/invoices/cells";
import { formatLocalDate, formatPeriod } from "@/lib/format/dates";
import { lineKindLabel } from "@/lib/format/labels";
import type { PayItemFor, PayItemView } from "@/lib/records/views";
import { readPayItemView } from "@/lib/records/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

// The words the paystub line starts with, for each kind of pay item (the line reads the same).
const HEAD: Record<PayItemView["kind"], string> = {
  reimbursement: "Reimbursement",
  fuel: "Fuel, company card",
  other_deduction: "Deduction",
  carried_shortfall: "Shortfall carried from last week",
};

const KIND: Record<PayItemView["kind"], ReactNode> = {
  reimbursement: <Term id="reimbursement">Reimbursement</Term>,
  fuel: "Fuel bought on the company card",
  other_deduction: <Term id="deductions">Deduction</Term>,
  carried_shortfall: <Term id="carried-shortfall">Carried shortfall</Term>,
};

function titleOf(item: PayItemView): string {
  const what = lineDescription(item.subkind ? `${HEAD[item.kind]} (${item.subkind})` : HEAD[item.kind]);
  const load = item.for.kind === "load" || item.for.kind === "extra_charge" ? item.for.load.label : null;
  return load ? `${what} on ${load.replace(/^Load /, "load ")}` : what;
}

function ForValue({ value }: { value: PayItemFor }) {
  switch (value.kind) {
    case "load":
      return <RecordLink table="loads" id={value.load.id}>{value.load.label}</RecordLink>;
    case "extra_charge":
      return (
        <RecordLink table="load_accessorials" id={value.chargeId}>
          {lineKindLabel(value.chargeKind)} on {value.load.label}
        </RecordLink>
      );
    case "paystub":
      return (
        <RecordLink table="settlements" id={value.paystub.id}>
          Paystub, {formatPeriod(value.paystub.periodStart, value.paystub.periodEnd)}
        </RecordLink>
      );
    case "fuel_purchase":
      return (
        <span>
          Fuel bought {formatLocalDate(value.purchasedOn)} in {value.state}, <Money cents={value.amountCents} tone="plain" />
        </span>
      );
    case "correction":
      return <span>A pay correction</span>;
    case "none":
      return <span>Not tied to a load</span>;
  }
}

// One pay item: a reimbursement, a fuel charge, a deduction or a shortfall carried from an earlier
// week. Read only; a paystub line links here.
export default async function PayItemRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, (q, rid) => readPayItemView(q, rid));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/settlements" title="Pay item">
        <PageHeader title="Pay item" />
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const item = page.record;
  const title = titleOf(item);
  const paidBack = item.kind === "reimbursement";
  return (
    <SignedInPage tenant={page.shell} current="/settlements" title={title}>
      <PageHeader
        title={title}
        description={item.driver ? <RecordLink table="drivers" id={item.driver.id}>{item.driver.name}</RecordLink> : undefined}
      />
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: paidBack ? "Paid back to the driver" : "Taken out of pay", value: <Money cents={item.amountCents} tone="plain" /> },
              { label: "Date", value: <Day value={item.itemDate} /> },
              { label: "Kind", value: KIND[item.kind] },
              { label: "For", value: <ForValue value={item.for} /> },
              {
                label: "On paystub",
                value: item.paidOn ? (
                  <RecordLink table="settlements" id={item.paidOn.id}>
                    {formatPeriod(item.paidOn.periodStart, item.paidOn.periodEnd)}
                  </RecordLink>
                ) : (
                  "Not paid yet"
                ),
              },
              {
                label: "Recorded by",
                value: item.correction ? "A pay correction a person approved in this app" : "The carrier's office",
              },
              ...(item.description ? [{ label: "Note", value: item.description }] : []),
            ]}
          />
        </CardBody>
      </Card>
    </SignedInPage>
  );
}
