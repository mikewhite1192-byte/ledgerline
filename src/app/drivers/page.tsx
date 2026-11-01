import Link from "next/link";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { RecordLink } from "@/components/invoices/cells";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { DbError } from "@/lib/db";
import { readCardedDrivers, readDriverInsightInput } from "@/lib/data/driver-insights";
import { ReadLimitError } from "@/lib/data/read";
import { recordHref } from "@/lib/records/href";
import { WORKER_WORDS } from "@/lib/reports/build";
import { driverInsightsOf, type DriverInsight } from "@/lib/reports/driver-insights";
import type { DriverLeaders } from "@/lib/reports/types";
import { InputError } from "@/lib/rules-engine";
import {
  ARMED,
  ARMED_WORDS,
  count,
  DAYS,
  DEFAULTS,
  filtersOf,
  hrefFor,
  leadersLine,
  LIST_LIMIT,
  listRows,
  miles,
  nameOf,
  SEARCH_MAX,
  SORT_WORDS,
  SORTS,
  STATUS_WORDS,
  STATUSES,
  type Filters,
} from "@/lib/drivers/list";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";
import { addDays } from "@/lib/time/local-date";

export const dynamic = "force-dynamic";

type View = { shell: ShellTenant; rows: DriverInsight[]; leaders: DriverLeaders; carded: Set<string> };

// Every driver on file with what they earned, hauled and owe over the last 28, 90 or 365 days of
// the carrier's own dates (the driver insights report's numbers), filtered and sorted by links,
// searched by code or name. Each name opens the driver's record. Read only.
export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const f = filtersOf(await searchParams);
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      const today = carrierToday(shell.timezone, new Date());
      const window = { start: addDays(today, -(Number(f.days) - 1)), end: today };
      const input = await readDriverInsightInput(q, window);
      const carded = await readCardedDrivers(q);
      const insights = driverInsightsOf(input, window, today, { everyDriver: true });
      return { shell, rows: insights.rows, leaders: insights.leaders, carded };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    // A failed read, a read past its row bound, an amount that is not whole cents, or a record the
    // engine refuses: the drivers cannot be shown, never shown as empty.
    else if (
      err instanceof DbError ||
      err instanceof ReadLimitError ||
      err instanceof RangeError ||
      err instanceof InputError
    ) {
      // The category only, never the text, so an outage and a bound are told apart in the log.
      console.error("drivers page unreadable:", err.name);
      problem = "unreadable";
    } else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;

  const all = listRows(view.rows, f);
  const shown = all.slice(0, LIST_LIMIT);
  const carded = view.carded;
  const link = (label: string, next: Filters, current: boolean) => (
    <Link
      key={label}
      href={hrefFor(next)}
      aria-current={current ? "page" : undefined}
      className={cn(buttonVariants({ variant: current ? "secondary" : "ghost", size: "sm" }), current && "font-semibold")}
    >
      {label}
    </Link>
  );
  const dot = <span aria-hidden className="mx-1 self-center text-muted-foreground">·</span>;

  return (
    <SignedInPage tenant={view.shell} current="/drivers" title="Drivers">
      <PageHeader
        title="Drivers"
        description="Every driver on file with what they earned, hauled and still owe. Ask the agent who earned or owes the most."
      />
      <p className="text-small text-foreground-2">{leadersLine(f.days, view.leaders)}</p>
      <form method="get" action="/drivers" role="search" className="flex flex-wrap items-end gap-2">
        {(["status", "armed", "days", "sort"] as const).map((k) =>
          f[k] === DEFAULTS[k] ? null : <input key={k} type="hidden" name={k} value={f[k]} />,
        )}
        <label className="grid gap-1 text-small font-medium text-foreground">
          Search by code or name
          <Input name="q" defaultValue={f.q} maxLength={SEARCH_MAX} autoComplete="off" className="w-64" />
        </label>
        <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Search
        </button>
      </form>
      <nav aria-label="Filter drivers" className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => link(STATUS_WORDS[s], { ...f, status: s }, f.status === s))}
        {dot}
        {ARMED.map((a) => link(ARMED_WORDS[a], { ...f, armed: a }, f.armed === a))}
        {dot}
        {DAYS.map((d) => link(`${d} days`, { ...f, days: d }, f.days === d))}
      </nav>
      <nav aria-label="Sort drivers" className="flex flex-wrap gap-1.5">
        {SORTS.map((s) => link(SORT_WORDS[s], { ...f, sort: s }, f.sort === s))}
      </nav>
      <DataTable<DriverInsight>
        caption={`${STATUS_WORDS[f.status]} drivers, last ${f.days} days, by ${SORT_WORDS[f.sort].toLowerCase()}`}
        rows={shown}
        rowKey={(r) => r.driver.id}
        empty={{
          title: f.q ? "No driver matches that search" : "No drivers match these filters",
          body: "Try another filter, or All.",
        }}
        columns={[
          {
            key: "driver",
            header: "Driver",
            cell: (r) => (
              <span className="whitespace-nowrap">
                <RecordLink table="drivers" id={r.driver.id}>
                  {nameOf(r)}
                </RecordLink>
                <span className="block text-small text-muted-foreground">{r.driver.code}</span>
              </span>
            ),
          },
          { key: "type", header: "Type", cell: (r) => WORKER_WORDS[r.driver.workerType] },
          {
            key: "status",
            header: "Status",
            cell: (r) => (
              <span className="flex flex-wrap gap-1">
                <Badge tone={r.departed ? "neutral" : "success"}>{r.departed ? "Departed" : "Active"}</Badge>
                <Badge tone={r.driver.moneyArmed ? "info" : "warning"}>
                  {r.driver.moneyArmed ? "Armed" : "Not armed"}
                </Badge>
                {carded.has(r.driver.id) ? null : (
                  <Link href={recordHref({ table: "drivers", id: r.driver.id })}>
                    <Badge tone="warning">No card</Badge>
                  </Link>
                )}
              </span>
            ),
          },
          { key: "net", header: "Net", align: "right", cell: (r) => <Money cents={r.netCents} tone="plain" /> },
          { key: "gross", header: "Gross", align: "right", cell: (r) => <Money cents={r.grossCents} tone="plain" /> },
          { key: "loads", header: "Loads", align: "right", cell: (r) => count(r.loads) },
          { key: "miles", header: "Miles", align: "right", cell: (r) => count(miles(r)) },
          { key: "owed", header: "Owed", align: "right", cell: (r) => <Money cents={r.owedCents} tone="plain" /> },
        ]}
      />
      {all.length > LIST_LIMIT ? (
        <p className="text-small text-foreground-2">
          Showing the first {LIST_LIMIT} of {count(all.length)} drivers. Search or filter to narrow the list.
        </p>
      ) : null}
    </SignedInPage>
  );
}
