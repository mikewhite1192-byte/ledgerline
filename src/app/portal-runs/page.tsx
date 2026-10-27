import Link from "next/link";
import { notFound } from "next/navigation";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { DataTable } from "@/components/app/data-table";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { PortalRunActions } from "@/components/portal/run-actions";
import { flags } from "@/config/flags";
import { formatInstant } from "@/lib/format/dates";
import { formatSpend } from "@/lib/trace/format";
import { portalLoadChoices, listRuns, type RunSummary } from "@/lib/portal/views";
import { CarrierProblem, readCarrier, signOut } from "./carrier";

// Portal runs: each time the agent read the broker's portal for a load, newest first, with a way
// to start one and a way to open the portal yourself.
export const dynamic = "force-dynamic";

export default async function PortalRunsPage() {
  if (!flags.portalRunnerEnabled) notFound();
  const read = await readCarrier(async (q) => ({
    runs: await listRuns(q, new Date()),
    choices: await portalLoadChoices(q),
  }));
  if ("problem" in read) return <CarrierProblem problem={read.problem} />;
  const { carrier, data } = read;
  const tz = carrier.timezone;
  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: tz }}
      nav={appNav("/portal-runs")}
      title="Portal runs"
      signOut={signOut}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6">
        <PageHeader
          title="Portal runs"
          description="The agent opens the broker's portal, finds a delivered load and brings back the check-in and check-out times and the signed POD. It only reads; any safety check waits for a person."
        />
        <PortalRunActions choices={data.choices} />
        <DataTable<RunSummary>
          caption="Runs, newest first"
          rows={data.runs}
          rowKey={(r) => r.id}
          empty={{ title: "No portal runs yet", body: "Pick a delivered load above to start one, or ask the agent for a load's delivery times." }}
          columns={[
            {
              key: "load",
              header: "Load",
              cell: (r) => (
                <Link href={`/portal-runs/${r.id}`} className="font-medium text-link underline-offset-2 hover:underline">
                  {r.loadNumber} <span className="text-muted-foreground">({r.reference})</span>
                </Link>
              ),
            },
            { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.stalled ? "unknown" : r.status} label={r.stalled ? "Stalled" : undefined} /> },
            { key: "steps", header: "Steps", align: "right", cell: (r) => r.stepCount },
            { key: "cost", header: "Cost", align: "right", cell: (r) => formatSpend(r.costNanocents) },
            { key: "started", header: "Started", cell: (r) => formatInstant(r.createdAt, tz) },
            { key: "by", header: "By", cell: (r) => r.requestedBy ?? "Former member", wrap: true },
          ]}
        />
      </div>
    </AppShell>
  );
}
