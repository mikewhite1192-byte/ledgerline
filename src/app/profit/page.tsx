import Link from "next/link";
import type { ReactNode } from "react";
import { TrendingUp } from "lucide-react";
import { flags } from "@/config/flags";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState, FeatureOff } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { RecordLink } from "@/components/invoices/cells";
import { WriteBrief } from "@/components/profit/write-brief";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { bpsText, type CustomerWeek, type ProfitWeek } from "@/lib/briefs/figures";
import { briefLinks, type FigureHref } from "@/lib/briefs/render";
import { readProfitView, type BriefState, type ProfitView } from "@/lib/briefs/view";
import { refusalWords } from "@/lib/briefs/words";
import { cn } from "@/lib/cn";
import { DbError } from "@/lib/db";
import { formatInstant, formatPeriod } from "@/lib/format/dates";
import { paymentHabitLabel } from "@/lib/format/labels";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import { reportPath } from "@/lib/reports/types";
import type { LaneRollup } from "@/lib/rules-engine";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

type View = { shell: ShellTenant; profit: ProfitView | null };

// Where a figure in the brief links: a customer to its record page, a week's totals to the margin
// report's file (only while reports are on; otherwise the number shows as plain text).
const hrefFor: FigureHref = (source) => {
  if ("table" in source) return hrefOrNull(recordHref, source);
  return flags.reportsEnabled ? reportPath(source.report, source.args, "csv") : null;
};

// Last week's money in and out, by route and by customer, and how fast each customer pays. Every
// figure comes from the rules engine; "Write this week's brief" asks the agent to put them in words,
// and the words are checked against them. The switch off shows the off state and reads nothing else.
export default async function ProfitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const asked = (await searchParams).week;
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      if (!flags.profitBriefEnabled) return { shell, profit: null };
      const now = new Date();
      return {
        shell,
        profit: await readProfitView(
          q,
          carrierToday(shell.timezone, now),
          typeof asked === "string" ? asked : null,
          flags.profitBriefLimits,
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
  const profit = view.profit;
  const week = profit?.week ?? null;
  const data = profit?.profit ?? null;
  // One next step: offered only when the agent is on, the week has priced loads, and no brief is
  // written or being written.
  const briefKind = profit?.brief.kind;
  const canWrite =
    flags.aiEnabled &&
    week !== null &&
    data !== null &&
    data.totals.loads > 0 &&
    (briefKind === "none" || briefKind === "refused");

  return (
    <SignedInPage tenant={view.shell} current="/profit" title="Profit brief">
      <PageHeader
        title="Profit brief"
        description="Last week's revenue, driver pay and margin by route and by customer, and how fast each customer pays. Every number links to where it came from."
      />
      {!profit ? (
        <Card>
          <FeatureOff name="Profit brief" />
        </Card>
      ) : !week || !data ? (
        <Card>
          <EmptyState
            icon={<TrendingUp aria-hidden />}
            title="The first brief appears after the first pay week closes."
            body="Approve a pay week under Settlements; its figures and the brief show here the next day."
          />
        </Card>
      ) : (
        <>
          <nav aria-label="Pay weeks" className="flex gap-1 overflow-x-auto border-b border-border">
            {profit.weeks.map((w) => (
              <Link
                key={w.id}
                href={`/profit?week=${encodeURIComponent(w.start)}`}
                aria-current={w.start === week.start ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-body whitespace-nowrap",
                  w.start === week.start
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-foreground-2 hover:text-foreground",
                )}
              >
                {formatPeriod(w.start, w.end)}
              </Link>
            ))}
          </nav>
          <Totals data={data} />
          <BriefCard
            state={profit.brief}
            timezone={view.shell.timezone}
            action={
              canWrite ? (
                <WriteBrief
                  periodStart={week.start}
                  weekText={formatPeriod(week.start, week.end)}
                  again={profit.brief.kind === "refused"}
                  maxCents={flags.profitBriefLimits.maxBriefCents}
                />
              ) : null
            }
            noLoads={data.totals.loads === 0}
          />
          <RouteTable rows={data.routes} />
          <CustomerTable rows={data.customers} />
        </>
      )}
    </SignedInPage>
  );
}

function Totals({ data }: { data: ProfitWeek }) {
  const { totals, unpriced } = data;
  const reportHref = flags.reportsEnabled
    ? reportPath("margin_per_load", { periodStart: data.period.start, periodEnd: data.period.end }, "csv")
    : undefined;
  const unpricedHint =
    unpriced.length === 0
      ? "Every delivered load is priced"
      : `Not priced: ${unpriced
          .slice(0, 3)
          .map((u) => u.loadNumber)
          .join(", ")}${unpriced.length > 3 ? ` and ${unpriced.length - 3} more` : ""}`;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Revenue"
        value={<Money cents={totals.revenueCents} />}
        hint={reportHref ? "Download the loads behind it" : "From priced loads"}
        href={reportHref}
      />
      <StatCard label="Driver pay" value={<Money cents={totals.driverPayCents} />} hint="On the same loads" />
      <StatCard
        label={<Term id="margin">Margin</Term>}
        value={<Money cents={totals.marginCents} />}
        hint={totals.marginBps === null ? "No revenue this week" : `${bpsText(totals.marginBps)} of revenue`}
        tone={totals.marginCents < 0 ? "destructive" : "neutral"}
      />
      <StatCard
        label="Loads priced"
        value={`${totals.loads.toLocaleString("en-US")} of ${totals.loadsDelivered.toLocaleString("en-US")}`}
        hint={unpricedHint}
        tone={unpriced.length > 0 ? "warning" : "neutral"}
      />
    </div>
  );
}

function BriefCard({
  state,
  timezone,
  action,
  noLoads,
}: {
  state: BriefState;
  timezone: string;
  action: ReactNode;
  noLoads: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>In plain words</CardTitle>
      </CardHeader>
      <CardBody className="grid gap-3">
        {state.kind === "drafted" ? (
          <>
            <p className="max-w-[72ch] text-body text-foreground">
              {briefLinks(state.brief.text ?? "", state.brief.figures, hrefFor).map((piece, i) =>
                piece.href ? (
                  <Link
                    key={i}
                    href={piece.href}
                    title={piece.label}
                    className="text-link underline decoration-border underline-offset-4 hover:decoration-current"
                  >
                    {piece.text}
                  </Link>
                ) : (
                  <span key={i}>{piece.text}</span>
                ),
              )}
            </p>
            <p className="text-small text-foreground-2">
              Written by the agent from the figures below; checked against them.
              {state.changed
                ? ` The figures below changed after this brief was written on ${formatInstant(state.brief.updatedAt, timezone)}.`
                : ""}
            </p>
          </>
        ) : state.kind === "writing" ? (
          <p role="status" className="text-body text-foreground-2">
            The brief is being written. Reload this page in a minute to read it.
          </p>
        ) : state.kind === "refused" ? (
          <p className="text-body text-foreground">{refusalWords(state.category)}</p>
        ) : noLoads ? (
          <p className="text-body text-foreground-2">
            No delivered load was priced this week, so there is nothing to write about. Pick another week above.
          </p>
        ) : (
          <p className="text-body text-foreground-2">
            No brief for this week yet. The agent puts the figures below into a few plain sentences, and every
            number is checked against them.
          </p>
        )}
        {action}
      </CardBody>
    </Card>
  );
}

function RouteTable({ rows }: { rows: LaneRollup[] }) {
  return (
    <DataTable
      caption="By route"
      rows={rows}
      rowKey={(r) => r.route}
      empty={{ title: "Routes appear here", body: "Each route with a priced load this week shows here." }}
      columns={[
        { key: "route", header: "Route", wrap: true, cell: (r) => r.route },
        { key: "loads", header: "Loads", align: "right", cell: (r) => r.loads.toLocaleString("en-US") },
        { key: "revenue", header: "Revenue", align: "right", cell: (r) => <Money cents={r.revenueCents} /> },
        { key: "pay", header: "Driver pay", align: "right", cell: (r) => <Money cents={r.driverPayCents} /> },
        { key: "margin", header: "Margin", align: "right", cell: (r) => <Money cents={r.marginCents} /> },
        {
          key: "pct",
          header: "Margin %",
          align: "right",
          cell: (r) => (r.marginBps === null ? "None" : bpsText(r.marginBps)),
        },
        {
          key: "mile",
          header: <Term id="loaded-miles">Per loaded mile</Term>,
          align: "right",
          cell: (r) => (r.centsPerLoadedMile === null ? "None" : <Money cents={r.centsPerLoadedMile} />),
        },
      ]}
    />
  );
}

function CustomerTable({ rows }: { rows: CustomerWeek[] }) {
  return (
    <DataTable
      caption="By customer"
      rows={rows}
      rowKey={(r) => r.customerId}
      empty={{ title: "Customers appear here", body: "Each customer with a priced load this week shows here." }}
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
        { key: "loads", header: "Loads", align: "right", cell: (r) => r.loads.toLocaleString("en-US") },
        { key: "revenue", header: "Revenue", align: "right", cell: (r) => <Money cents={r.revenueCents} /> },
        { key: "margin", header: "Margin", align: "right", cell: (r) => <Money cents={r.marginCents} /> },
        {
          key: "pct",
          header: "Margin %",
          align: "right",
          cell: (r) => (r.marginBps === null ? "None" : bpsText(r.marginBps)),
        },
        {
          key: "days",
          header: <Term id="days-to-pay">Pays in (days, mean)</Term>,
          align: "right",
          cell: (r) => (r.meanDays === null ? "No paid invoices yet" : r.meanDays.toLocaleString("en-US")),
        },
        { key: "habit", header: "Payment habit", cell: (r) => paymentHabitLabel(r.habit) },
      ]}
    />
  );
}
