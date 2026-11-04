import Link from "next/link";
import { flags } from "@/config/flags";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { DataTable } from "@/components/app/data-table";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { CarryOn } from "@/components/sweep/carry-on";
import { StartSweep } from "@/components/sweep/start-sweep";
import { Card } from "@/components/ui/card";
import { formatInstant, formatPeriod } from "@/lib/format/dates";
import { codeToWords } from "@/lib/format/labels";
import { readSweepHome, type SweepHome } from "@/lib/sweep/view";
import { sweepOutcome } from "@/lib/sweep/words";
import { NoCarrier, readCarrier, SignOut, SweepOffPage } from "./carrier";

// The pay check's page (the sweep, in the office's words): run it for the open week, the last
// run's outcome line and counts, and the runs so far. Under the simple shape (flags.simpleShape)
// the runs so far fold under "Past checks".
export const dynamic = "force-dynamic";

function when(iso: string, timezone: string): string {
  try {
    return formatInstant(iso, timezone);
  } catch {
    return iso;
  }
}

function week(run: { periodStart: string; periodEnd: string }): string {
  try {
    return formatPeriod(run.periodStart, run.periodEnd);
  } catch {
    return run.periodStart;
  }
}

const DESCRIPTION =
  "I check every driver's pay for the open week, draft a fix for each mistake I can, and list the rest for you. Nothing changes until you approve.";

const TITLE = "Pay check";

export default async function SweepPage() {
  if (!flags.sweepEnabled) return <SweepOffPage title={TITLE} description={DESCRIPTION} />;
  const read = await readCarrier();
  if ("problem" in read) return <NoCarrier problem={read.problem} />;
  const { carrier } = read;

  // Unknown is not empty: a failed read shows the error, never "no sweep yet".
  let home: SweepHome | null = null;
  try {
    home = await readSweepHome(carrier.session);
  } catch (err) {
    console.error("sweep list read failed:", err instanceof Error ? err.name : "unknown");
  }
  const last = home?.runs[0] ?? null;
  const running = home?.runs.some((r) => r.status === "running") ?? false;
  // A run started from the button and left before its own page opened would sit at its first
  // slice: this page carries a running run on too (CarryOn skips the judge role).
  const runningId = home?.runs.find((r) => r.status === "running")?.id;
  const simple = flags.simpleShape.enabled === true;

  type Run = NonNullable<typeof home>["runs"][number];
  const counterColumns = [
    { key: "found", header: "Found", align: "right" as const, cell: (r: Run) => r.counts.found ?? "" },
    { key: "drafted", header: "Drafted", align: "right" as const, cell: (r: Run) => r.counts.fixes_drafted ?? "" },
    { key: "clean", header: "Clean", align: "right" as const, cell: (r: Run) => r.counts.clean ?? "" },
  ];
  const pastChecks = (
    <DataTable
      caption="Past checks"
      rows={home?.runs ?? []}
      rowKey={(r) => r.id}
      empty={{
        title: "No pay check yet",
        body: "Run one to see what it finds in this week's pay.",
      }}
      columns={[
        {
          key: "started",
          header: "Started",
          cell: (r) => (
            <Link href={`/sweep/${r.id}`} className="text-link underline-offset-4 hover:underline">
              {when(r.startedAt, carrier.timezone)}
            </Link>
          ),
        },
        { key: "week", header: "Week", cell: (r) => week(r) },
        { key: "trigger", header: "Started by", cell: (r) => (r.trigger === "schedule" ? "Nightly" : "Button") },
        { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status === "running" ? "executing" : r.status} label={codeToWords(r.status)} /> },
        // The simple shape leaves the counters out; each run's own page has its outcome.
        ...(simple ? [] : counterColumns),
      ]}
    />
  );

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone, role: carrier.role }}
      nav={appNav("/sweep")}
      title={TITLE}
      signOut={<SignOut />}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6 px-4 py-6 md:px-6 md:py-8">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        {flags.fuelAnomalyEnabled ? (
          <Card className="grid gap-1 px-4 py-3 sm:px-5">
            <Link href="/sweep/fuel" className="w-fit text-body font-semibold text-link underline-offset-4 hover:underline">
              Fuel checks
            </Link>
            <p className="text-small text-foreground-2">Fill-ups that do not fit the truck, the route or the day.</p>
          </Card>
        ) : null}
        {home === null ? (
          <Card>
            <ErrorState category="unreadable" />
          </Card>
        ) : (
          <>
            <Card className="grid gap-4 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5">
              <div className="grid gap-1">
                <p className="text-body text-foreground">
                  {home.openPeriod ? `Open week: ${week(home.openPeriod)}` : "There is no open pay week right now."}
                </p>
                {last ? (
                  <p className="text-small text-foreground-2">
                    {sweepOutcome(last, "page")}{" "}
                    <Link href={`/sweep/${last.id}`} className="text-link underline-offset-4 hover:underline">
                      Open it
                    </Link>
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {running ? <StatusBadge status="executing" label="Running" /> : null}
                {runningId ? <CarryOn runId={runningId} /> : null}
                <StartSweep hasOpenWeek={home.openPeriod !== null} running={running} />
              </div>
            </Card>
            {!simple && last && last.status !== "running" ? (
              <section aria-label="Last check" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Found" value={last.counts.found ?? 0} />
                <StatCard label="Fixes drafted" value={last.counts.fixes_drafted ?? 0} />
                <StatCard label="Clean" value={last.counts.clean ?? 0} />
                <StatCard label="Need you" value={last.counts.needs_person ?? 0} />
              </section>
            ) : null}
            {simple && home.runs.length === 0 ? null : simple ? (
              <details className="rounded-lg border border-border bg-card px-4 py-3">
                <summary className="cursor-pointer text-body font-semibold text-foreground">Past checks ({home.runs.length})</summary>
                <div className="mt-3">{pastChecks}</div>
              </details>
            ) : (
              pastChecks
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
