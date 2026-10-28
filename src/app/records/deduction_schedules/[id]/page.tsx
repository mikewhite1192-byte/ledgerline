import type { ReactNode } from "react";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { Card, CardBody } from "@/components/ui/card";
import { Day, Facts, RecordLink } from "@/components/invoices/cells";
import type { TermId } from "@/lib/format/terms";
import { formatCents } from "@/lib/format/money";
import type { ScheduleView } from "@/lib/records/views";
import { readScheduleView } from "@/lib/records/views";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

const NAME: Record<ScheduleView["kind"], string> = {
  escrow: "Escrow",
  lease: "Truck lease",
  other: "Scheduled deduction",
};

const TERM: Partial<Record<ScheduleView["kind"], TermId>> = { escrow: "escrow", lease: "truck-lease" };

function escrowFacts(e: NonNullable<ScheduleView["escrow"]>): { label: string; value: ReactNode; term?: TermId }[] {
  const held = e.balanceCents === null ? "Not known" : <Money cents={e.balanceCents} tone="plain" />;
  const target = e.targetCents === null ? "No target set" : <Money cents={e.targetCents} tone="plain" />;
  let left: ReactNode = "Not known";
  if (e.balanceCents !== null && e.targetCents !== null) {
    left = e.balanceCents >= e.targetCents ? "Target reached" : <Money cents={e.targetCents - e.balanceCents} tone="plain" />;
  }
  return [
    { label: "Held now", term: "escrow", value: held },
    { label: "Target", value: target },
    { label: "Left to reach the target", value: left },
  ];
}

// One weekly deduction a driver agreed to: escrow, a truck lease, or another. A paystub's escrow or
// lease line links here. Read only.
export default async function ScheduleRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, (q, rid) => readScheduleView(q, rid));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/settlements" title="Weekly deduction">
        <PageHeader title="Weekly deduction" />
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const s = page.record;
  const title = `${NAME[s.kind]}, ${formatCents(s.amountCents)} a week`;
  return (
    <SignedInPage tenant={page.shell} current="/settlements" title={title}>
      <PageHeader
        title={title}
        description={s.driver ? <RecordLink table="drivers" id={s.driver.id}>{s.driver.name}</RecordLink> : undefined}
      />
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Taken each week", term: TERM[s.kind], value: <Money cents={s.amountCents} tone="plain" /> },
              { label: "Starts", value: <Day value={s.activeFrom} /> },
              { label: "Ends", value: s.activeTo ? <Day value={s.activeTo} /> : "No end date" },
              ...(s.escrow ? escrowFacts(s.escrow) : []),
              ...(s.description && s.description !== NAME[s.kind] ? [{ label: "Note", value: s.description }] : []),
            ]}
          />
        </CardBody>
      </Card>
    </SignedInPage>
  );
}
