import { notFound } from "next/navigation";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { PortalRunLive } from "@/components/portal/run-live";
import { flags } from "@/config/flags";
import { runView } from "@/lib/portal/views";
import { isUuid } from "@/lib/uuid";
import { CarrierProblem, PortalRunsOffPage, readCarrier, signOut } from "../carrier";

// One portal run: its status, the approval card while a safety check waits, the steps with what
// the agent saw, and the evidence it brought back. The page polls while the run is live.
export const dynamic = "force-dynamic";

export default async function PortalRunPage({ params }: { params: Promise<{ id: string }> }) {
  if (!flags.portalRunnerEnabled) return <PortalRunsOffPage title="Portal run" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const read = await readCarrier((q) => runView(q, id, new Date()));
  if ("problem" in read) return <CarrierProblem problem={read.problem} />;
  if (!read.data) notFound();
  const { carrier, data } = read;
  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/portal-runs")}
      title="Portal run"
      signOut={signOut}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6">
        <PageHeader title={`Portal run for load ${data.run.loadNumber}`} />
        <PortalRunLive initial={data} timeZone={carrier.timezone} />
      </div>
    </AppShell>
  );
}
