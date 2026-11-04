import Link from "next/link";
import { flags } from "@/config/flags";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState, FeatureOff } from "@/components/app/states";
import { LiveRefresh } from "@/components/feed/live-refresh";
import { JourneySteps } from "@/components/journey/journey-steps";
import { Card } from "@/components/ui/card";
import { readJourneys } from "@/lib/journey/read";
import { journeyStepsOf, stillMoving, type JourneyFacts, type JourneyStep } from "@/lib/journey/steps";
import { readRecordPage } from "../../../read-record";

export const dynamic = "force-dynamic";

const LINK = "text-small text-link underline-offset-4 hover:underline";

type Read = { off: true } | { off: false; facts: JourneyFacts };

// The steps as the page shows them: a document link only while documents are on, since the
// document page and its file refuse otherwise.
function stepsFor(facts: JourneyFacts, zone: string): JourneyStep[] {
  const steps = journeyStepsOf(facts, {
    zone,
    books: { enabled: flags.books.enabled, startDate: flags.books.startDate, maxAttempts: flags.books.maxAttempts },
  });
  if (flags.documentsEnabled) return steps;
  return steps.map((s) => (s.href?.startsWith("/documents/") ? { ...s, href: null, hrefLabel: null } : s));
}

// One load's whole road, from the bill of lading to the paystub in QuickBooks, read from the rows
// each step already wrote. Read only: nothing here writes. While a step is still to come the page
// reads itself again every few seconds; once all eight are settled it stops.
export default async function LoadJourney({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, async (q, rid): Promise<Read | null> => {
    if (!flags.journey.enabled) return { off: true };
    const facts = (await readJourneys(q, [rid], new Date())).get(rid) ?? null;
    return facts === null ? null : { off: false, facts };
  });
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="/road" title="Load journey">
        <PageHeader title="Load journey" />
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const read = page.record;
  if (read.off) {
    return (
      <SignedInPage tenant={page.shell} current="/road" title="Load journey">
        <PageHeader title="Load journey" />
        <Card>
          <FeatureOff name="The load journey" />
        </Card>
      </SignedInPage>
    );
  }
  const { load } = read.facts;
  let steps: JourneyStep[];
  try {
    steps = stepsFor(read.facts, page.shell.timezone);
  } catch (err) {
    // A stored time or zone that does not read: the road cannot be shown, never shown as empty.
    if (err instanceof RangeError) return <NoCarrierPage problem="unreadable" />;
    throw err;
  }
  const moving = stillMoving(steps);
  return (
    <SignedInPage
      tenant={page.shell}
      current="/road"
      title={`Load ${load.number} journey`}
      focus={{ table: "loads", id: load.id, label: `Load ${load.number}` }}
    >
      <PageHeader
        title={`Load ${load.number}`}
        description={`${load.origin} to ${load.destination}${load.driverName ? `, ${load.driverName}` : ""}`}
        actions={moving ? <LiveRefresh pollSeconds={flags.journey.pollSeconds} /> : undefined}
      />
      <p className="text-small text-foreground-2">
        {moving
          ? "Every step from pickup to the paystub in QuickBooks, as it happens. Read only."
          : "Every step from pickup to the paystub in QuickBooks. All settled. Read only."}
      </p>
      <Card className="px-4 py-4 sm:px-5">
        <JourneySteps steps={steps} loadId={load.id} loadNumber={load.number} documentsOn={flags.documentsEnabled} />
      </Card>
      <div className="flex flex-wrap gap-4">
        <Link href={`/records/loads/${load.id}`} className={LINK}>
          Open the load
        </Link>
        <Link href="/road" className={LINK}>
          On the road
        </Link>
      </div>
    </SignedInPage>
  );
}
