import Link from "next/link";
import { flags } from "@/config/flags";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { DataTable } from "@/components/app/data-table";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { StartSweep } from "@/components/sweep/start-sweep";
import { Card } from "@/components/ui/card";
import { formatInstant, formatPeriod } from "@/lib/format/dates";
import { codeToWords } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";
import { readSweepHome, type SweepHome, type SweepRunView } from "@/lib/sweep/view";
import { NoCarrier, readCarrier, SignOut, SweepOffPage } from "./carrier";

// The sweep's page: run it for the open week, the last run's line and counts, and the runs so far.
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

function lastLine(run: SweepRunView): string {
  const found = run.counts.found ?? 0;
  const drafted = run.counts.fixes_drafted ?? 0;
  const problems = `${found} ${found === 1 ? "problem" : "problems"}`;
  const fixes = `${drafted} ${drafted === 1 ? "fix" : "fixes"}`;
  if (run.status === "running") return `A sweep of ${week(run)} is running now.`;
  if (run.status === "failed") return `The last sweep, of ${week(run)}, stopped before it finished.`;
  return run.trigger === "schedule"
    ? `Before anyone logged in, LedgerLine found ${problems} in the week of ${week(run)} and drafted ${fixes}.`
    : `LedgerLine checked the week of ${week(run)}, found ${problems} and drafted ${fixes}.`;
}

const DESCRIPTION =
  "LedgerLine checks every driver's pay for the open week, drafts a fix for each problem it can, and lists the rest for a person. Nothing changes until someone approves.";

export default async function SweepPage() {
  if (!flags.sweepEnabled) return <SweepOffPage title="Pay sweep" description={DESCRIPTION} />;
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

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/sweep")}
      title="Sweep"
      signOut={<SignOut />}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6 px-4 py-6 md:px-6 md:py-8">
        <PageHeader title="Pay sweep" description={DESCRIPTION} />
        {flags.fuelAnomalyEnabled ? (
          <Card className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
            <p className="text-small text-foreground-2">Fill-ups that do not fit the truck, the route or the day.</p>
            <Link href="/sweep/fuel" className="text-link underline-offset-4 hover:underline">
              Fuel checks
            </Link>
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
                    {lastLine(last)}{" "}
                    <Link href={`/sweep/${last.id}`} className="text-link underline-offset-4 hover:underline">
                      Open it
                    </Link>
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {running ? <StatusBadge status="executing" label="Running" /> : null}
                <StartSweep periodId={home.openPeriod?.id ?? null} running={running} />
              </div>
            </Card>
            {last && last.status !== "running" ? (
              <section aria-label="Last sweep" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Found" value={last.counts.found ?? 0} />
                <StatCard label="Fixes drafted" value={last.counts.fixes_drafted ?? 0} />
                <StatCard label="Clean" value={last.counts.clean ?? 0} />
                <StatCard label="Need a person" value={last.counts.needs_person ?? 0} />
              </section>
            ) : null}
            <DataTable
              caption="Sweeps"
              rows={home.runs}
              rowKey={(r) => r.id}
              empty={{
                title: "No sweep yet",
                body: "Run one to see what LedgerLine finds in this week's pay.",
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
                { key: "found", header: "Found", align: "right", cell: (r) => r.counts.found ?? "" },
                { key: "drafted", header: "Drafted", align: "right", cell: (r) => r.counts.fixes_drafted ?? "" },
                { key: "clean", header: "Clean", align: "right", cell: (r) => r.counts.clean ?? "" },
                { key: "spent", header: "Model spend", align: "right", cell: (r) => formatCents(r.spentCents) },
              ]}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
