import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { Card, CardBody } from "@/components/ui/card";
import { Day, Facts, RecordLink } from "@/components/invoices/cells";
import { formatLocalDate } from "@/lib/format/dates";
import type { DriverDayView } from "@/lib/records/views";
import { readDriverDayView } from "@/lib/records/views";
import { dayOfWeek } from "@/lib/time/local-date";
import { readRecordPage } from "../../read-record";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// Whether this day adds an insurance charge to the driver's paystub, in words.
function chargedWords(d: DriverDayView): string {
  if (!d.rules) return "No pay rules cover this week";
  if (d.ownInsurance) return "No, the driver carries their own insurance";
  if (d.rules.appliesTo === "owner_operator" && d.workerType !== "owner_operator") {
    return "No, this carrier charges insurance to owner-operators only";
  }
  if (d.workerType === null) return "Not known: the driver's record could not be read";
  return "Yes, once for this day";
}

// One day a driver drove. Insurance is charged once per day driven, so a paystub's insurance line
// links to each day it counted. Read only.
export default async function DriverDayRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, (q, rid) => readDriverDayView(q, rid));
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/settlements" title="Day driven">
        <PageHeader title="Day driven" />
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const d = page.record;
  const title = `Day driven, ${WEEKDAYS[dayOfWeek(d.day)]} ${formatLocalDate(d.day)}`;
  return (
    <SignedInPage tenant={page.shell} current="/settlements" title={title}>
      <PageHeader
        title={title}
        description={d.driver ? <RecordLink table="drivers" id={d.driver.id}>{d.driver.name}</RecordLink> : undefined}
      />
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Day", value: <Day value={d.day} /> },
              {
                label: "Known from",
                value: d.source === "load" ? "A load the driver hauled that day" : "The dispatch log",
              },
              {
                label: "Load",
                value: d.load ? <RecordLink table="loads" id={d.load.id}>{d.load.label}</RecordLink> : "No load that day",
              },
              {
                label: "Insurance per day",
                term: "insurance",
                value: d.rules ? <Money cents={d.rules.perDayCents} tone="plain" /> : "No pay rules cover this week",
              },
              {
                label: "Pay rules used",
                value: d.rules ? `In effect from ${formatLocalDate(d.rules.effectiveFrom)}` : "None",
              },
              { label: "Charged to this driver", value: chargedWords(d) },
              ...(d.rules?.note ? [{ label: "Rules note", value: d.rules.note }] : []),
            ]}
          />
        </CardBody>
      </Card>
      <p className="text-body text-foreground-2">
        <Term id="insurance">Insurance</Term> is charged once for each day driven, at the daily rate in the pay rules
        for that week.
      </p>
    </SignedInPage>
  );
}
