import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarRange } from "lucide-react";
import { flags } from "@/config/flags";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState, FeatureOff } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { RecordLink } from "@/components/invoices/cells";
import { WriteReview } from "@/components/quarter/write-review";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { bpsText } from "@/lib/briefs/figures";
import { briefLinks, type FigureHref } from "@/lib/briefs/render";
import { hasActivity, QUARTER_SECTIONS, readQuarterView, type QuarterState, type QuarterView } from "@/lib/briefs/quarter-review";
import { reviewRefusalWords, SECTION_TITLES } from "@/lib/briefs/quarter-words";
import { DbError } from "@/lib/db";
import { formatInstant, formatPeriod } from "@/lib/format/dates";
import { paymentHabitLabel } from "@/lib/format/labels";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import { reportPath } from "@/lib/reports/types";
import type { FigureSection, Quarter, QuarterCustomer, QuarterFixes, QuarterPayRun } from "@/lib/rules-engine";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

type View = { shell: ShellTenant; quarter: QuarterView | null };

// Where each part of the page sits, so a number in the review can point at the table that shows it.
const ANCHORS: Readonly<Record<FigureSection, string>> = {
  pay_runs: "quarter-pay-runs",
  customers: "quarter-customers",
  exceptions: "quarter-exceptions",
  recovered: "quarter-recovered",
};

// Where a figure in the review links: a customer or driver to its record page, a report's figures
// to the report file (only while reports are on; otherwise plain text), anything else to the table
// on this page that shows it.
const hrefFor: FigureHref = (source) => {
  if ("table" in source) return hrefOrNull(recordHref, source);
  if ("section" in source) return `#${ANCHORS[source.section]}`;
  return flags.reportsEnabled ? reportPath(source.report, source.args, "csv") : null;
};

const STATUS_WORDS: Readonly<Record<QuarterPayRun["status"], string>> = {
  open: "Open",
  approved: "Approved",
  paid: "Paid",
};

// The quarter so far: its pay runs, money in, money recovered and the problems found, every figure
// from your own records. "Write the quarter review" asks the agent to put them in four short lists,
// and every number in them is checked against these figures. The switch off shows the off state and
// reads nothing else.
export default async function QuarterPage() {
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      if (!flags.quarterReviewEnabled) return { shell, quarter: null };
      const now = new Date();
      return {
        shell,
        quarter: await readQuarterView(
          q,
          carrierToday(shell.timezone, now),
          shell.timezone,
          flags.quarterReviewLimits.maxInputChars,
          now,
        ),
      };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const data = view.quarter;
  const active = data !== null && hasActivity(data.quarter);
  // One next step: offered only when the agent is on, the quarter has something to review, and no
  // review is written or being written.
  const reviewKind = data?.review.kind;
  const canWrite = flags.aiEnabled && active && (reviewKind === "none" || reviewKind === "refused");

  return (
    <SignedInPage tenant={view.shell} current="/quarter" title="Quarter review">
      <PageHeader
        title="Quarter review"
        description="The quarter so far, from your pay runs, invoices and payments. The review is written from these figures and checked against them."
      />
      {!data ? (
        <Card>
          <FeatureOff name="Quarter review" />
        </Card>
      ) : !active ? (
        <Card>
          <EmptyState
            icon={<CalendarRange aria-hidden />}
            title="The quarter's figures appear after its first pay run or invoice."
            body="Run a pay week under Settlements or send an invoice; its figures show here."
          />
        </Card>
      ) : (
        <>
          <p className="text-small text-foreground-2">
            So far: {formatPeriod(data.quarter.window.start, data.quarter.window.end)}
          </p>
          <Totals q={data.quarter} />
          <ReviewCard
            state={data.review}
            timezone={view.shell.timezone}
            action={
              canWrite ? (
                <WriteReview again={data.review.kind === "refused"} maxCents={flags.quarterReviewLimits.maxReviewCents} />
              ) : null
            }
          />
          <PayRunTable rows={data.quarter.payRuns} />
          <RecoveredTable q={data.quarter} />
          <CustomerTable rows={data.quarter.customers} />
          <ExceptionTable q={data.quarter} />
        </>
      )}
    </SignedInPage>
  );
}

function Totals({ q }: { q: Quarter }) {
  const { pay, margin } = q;
  const runsHint = [
    `${pay.paid.toLocaleString("en-US")} paid`,
    pay.approved > 0 ? `${pay.approved.toLocaleString("en-US")} approved` : null,
    `${pay.open.toLocaleString("en-US")} open`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard label="Pay runs" value={pay.runs.toLocaleString("en-US")} hint={runsHint} href={`#${ANCHORS.pay_runs}`} />
      <StatCard
        label={<Term id="net-pay">Net pay</Term>}
        value={<Money cents={pay.netCents} />}
        hint="Paid and approved pay runs"
      />
      <StatCard
        label="Revenue invoiced"
        value={<Money cents={q.invoiced.cents} />}
        hint={`${q.invoiced.count.toLocaleString("en-US")} invoices`}
        href={`#${ANCHORS.customers}`}
      />
      <StatCard
        label="Payments received"
        value={<Money cents={q.received.cents} />}
        hint={`${q.received.count.toLocaleString("en-US")} payments`}
        href={`#${ANCHORS.customers}`}
      />
      <StatCard
        label={<Term id="margin">Margin</Term>}
        value={<Money cents={margin.marginCents} />}
        hint={margin.marginBps === null ? "No priced loads yet" : `${bpsText(margin.marginBps)} of revenue`}
        tone={margin.marginCents < 0 ? "destructive" : "neutral"}
      />
      <StatCard
        label="Money recovered"
        value={<Money cents={q.recovered.totalCents} />}
        hint="Detention, pay corrections and advances"
        href={`#${ANCHORS.recovered}`}
      />
    </div>
  );
}

function ReviewCard({ state, timezone, action }: { state: QuarterState; timezone: string; action: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>The review</CardTitle>
      </CardHeader>
      <CardBody className="grid gap-4">
        {state.kind === "drafted" && state.review.body ? (
          <>
            {QUARTER_SECTIONS.map((section) => (
              <section key={section} aria-label={SECTION_TITLES[section]} className="grid gap-1">
                <h2 className="text-body font-medium text-foreground">{SECTION_TITLES[section]}</h2>
                <ul className="grid max-w-[72ch] list-disc gap-1 pl-5 text-body text-foreground">
                  {state.review.body?.[section].map((item, i) => (
                    <li key={i}>
                      {briefLinks(item, state.review.figures, hrefFor).map((piece, j) =>
                        piece.href ? (
                          <Link
                            key={j}
                            href={piece.href}
                            title={piece.label}
                            className="text-link underline decoration-border underline-offset-4 hover:decoration-current"
                          >
                            {piece.text}
                          </Link>
                        ) : (
                          <span key={j}>{piece.text}</span>
                        ),
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="text-small text-foreground-2">
              Written by the agent from the figures on this page; checked against them.
              {state.changed
                ? ` The figures changed after this review was written on ${formatInstant(state.review.updatedAt, timezone)}; it keeps the figures it was written from.`
                : ""}
            </p>
          </>
        ) : state.kind === "writing" ? (
          <p role="status" className="text-body text-foreground-2">
            The review is being written. Reload this page in a minute to read it.
          </p>
        ) : state.kind === "refused" ? (
          <p className="text-body text-foreground">{reviewRefusalWords(state.category)}</p>
        ) : (
          <p className="text-body text-foreground-2">
            No review yet. The agent writes what went well, the recurring problems, the money recovered and three things
            to change, and every number is checked against the figures on this page.
          </p>
        )}
        {action}
      </CardBody>
    </Card>
  );
}

function PayRunTable({ rows }: { rows: QuarterPayRun[] }) {
  return (
    <section id={ANCHORS.pay_runs} className="scroll-mt-20">
      <DataTable
        caption="Pay runs"
        rows={rows}
        rowKey={(r) => r.periodId}
        empty={{ title: "Pay runs appear here", body: "Each pay week that ends this quarter shows here." }}
        columns={[
          {
            key: "week",
            header: <Term id="pay-period">Week</Term>,
            wrap: true,
            cell: (r) => (
              <RecordLink table="settlement_periods" id={r.periodId}>
                {formatPeriod(r.start, r.end)}
              </RecordLink>
            ),
          },
          { key: "status", header: "Status", cell: (r) => STATUS_WORDS[r.status] },
          { key: "drivers", header: "Drivers", align: "right", cell: (r) => r.paystubs.toLocaleString("en-US") },
          { key: "gross", header: <Term id="gross-pay">Gross</Term>, align: "right", cell: (r) => <Money cents={r.grossCents} /> },
          { key: "net", header: <Term id="net-pay">Net</Term>, align: "right", cell: (r) => <Money cents={r.netCents} /> },
          {
            key: "problems",
            header: "Paystubs with a problem",
            align: "right",
            cell: (r) => r.withProblem.toLocaleString("en-US"),
          },
        ]}
      />
    </section>
  );
}

function RecoveredTable({ q }: { q: Quarter }) {
  const r = q.recovered;
  const rows = [
    { key: "detention", what: "Detention billed after the agent found it", count: r.detentionCount, cents: r.detentionCents },
    { key: "corrections", what: "Pay corrections that took back an overpayment", count: r.correctionsCount, cents: r.correctionsCents },
    { key: "advances", what: "Advances taken back from pay", count: null, cents: r.advancesCents },
  ];
  return (
    <section id={ANCHORS.recovered} className="scroll-mt-20">
      <DataTable
        caption="Money recovered"
        rows={rows}
        rowKey={(row) => row.key}
        columns={[
          { key: "what", header: "From", wrap: true, cell: (row) => row.what },
          {
            key: "count",
            header: "Count",
            align: "right",
            cell: (row) => (row.count === null ? "Each paystub" : row.count.toLocaleString("en-US")),
          },
          { key: "amount", header: "Amount", align: "right", cell: (row) => <Money cents={row.cents} /> },
        ]}
      />
    </section>
  );
}

function CustomerTable({ rows }: { rows: QuarterCustomer[] }) {
  return (
    <section id={ANCHORS.customers} className="scroll-mt-20">
      <DataTable
        caption="Customers"
        rows={rows}
        rowKey={(r) => r.customerId}
        empty={{ title: "Customers appear here", body: "Each customer invoiced, paying or owing this quarter shows here." }}
        columns={[
          {
            key: "customer",
            header: "Customer",
            wrap: true,
            cell: (r) => (
              <RecordLink table="customers" id={r.customerId}>
                {r.customerName}
              </RecordLink>
            ),
          },
          { key: "invoiced", header: "Invoiced", align: "right", cell: (r) => <Money cents={r.invoicedCents} /> },
          { key: "received", header: "Paid", align: "right", cell: (r) => <Money cents={r.receivedCents} /> },
          { key: "open", header: "Still owed", align: "right", cell: (r) => <Money cents={r.openCents} /> },
          {
            key: "days",
            header: <Term id="days-to-pay">Pays in (days, mean)</Term>,
            align: "right",
            cell: (r) => (r.meanDays === null ? "No paid invoices yet" : r.meanDays.toLocaleString("en-US")),
          },
          { key: "habit", header: "Payment habit", cell: (r) => paymentHabitLabel(r.habit) },
        ]}
      />
    </section>
  );
}

function ExceptionTable({ q }: { q: Quarter }) {
  const fixed: (QuarterFixes & { key: string })[] = q.exceptions.byKind.map((k) => ({ ...k, key: k.label }));
  const rows = [
    {
      key: "paystubs",
      label: "Paystubs with a problem",
      count: q.pay.withProblem,
      amountCents: null as number | null,
    },
    {
      key: "detention",
      label: "Detention not billed yet",
      count: q.exceptions.unbilledLoads,
      amountCents: q.exceptions.unbilledCents as number | null,
    },
    ...fixed.map((k) => ({ key: `fix-${k.key}`, label: `Suggested: ${k.label}`, count: k.count, amountCents: k.amountCents as number | null })),
  ];
  return (
    <section id={ANCHORS.exceptions} className="scroll-mt-20">
      <DataTable
        caption="Exceptions"
        rows={rows}
        rowKey={(r) => r.key}
        columns={[
          { key: "type", header: "Type", wrap: true, cell: (r) => r.label },
          { key: "count", header: "Count", align: "right", cell: (r) => r.count.toLocaleString("en-US") },
          {
            key: "amount",
            header: "Dollars",
            align: "right",
            cell: (r) => (r.amountCents === null ? "None" : <Money cents={r.amountCents} />),
          },
        ]}
      />
      <p className="mt-2 text-small text-foreground-2">
        The agent suggested {q.exceptions.suggested.toLocaleString("en-US")} fixes so far:{" "}
        {q.exceptions.done.toLocaleString("en-US")} done, {q.exceptions.waiting.toLocaleString("en-US")} waiting for a
        decision, {q.exceptions.declined.toLocaleString("en-US")} turned down
        {q.exceptions.failed > 0 ? `, ${q.exceptions.failed.toLocaleString("en-US")} did not go through` : ""}.
      </p>
    </section>
  );
}
