import { notFound } from "next/navigation";
import { flags } from "@/config/flags";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { SweepRun } from "@/components/sweep/sweep-run";
import { Card } from "@/components/ui/card";
import { readSweepPage, type SweepPage } from "@/lib/sweep/view";
import { isUuid } from "@/lib/uuid";
import { NoCarrier, readCarrier, SignOut, SweepOffPage } from "../carrier";

// One sweep run: its counts, its drafted fixes and the lines for a person. The page carries a
// running run on itself, one slice per request.
export const dynamic = "force-dynamic";

export default async function SweepRunPage({ params }: { params: Promise<{ id: string }> }) {
  if (!flags.sweepEnabled) return <SweepOffPage title="Pay sweep" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const read = await readCarrier();
  if ("problem" in read) return <NoCarrier problem={read.problem} />;
  const { carrier } = read;

  let page: SweepPage | null = null;
  let problem: "unreadable" | "not_found" | null = null;
  try {
    page = await readSweepPage(carrier.session, id);
    if (!page) problem = "not_found";
  } catch (err) {
    problem = "unreadable";
    console.error("sweep run read failed:", err instanceof Error ? err.name : "unknown");
  }

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone, role: carrier.role }}
      nav={appNav("/sweep")}
      title="Sweep"
      signOut={<SignOut />}
    >
      {page ? (
        <SweepRun initial={page} auditorOn={flags.auditorEnabled} timezone={carrier.timezone} />
      ) : (
        <div className="mx-auto grid w-full max-w-[880px] gap-6 px-4 py-6 md:px-6 md:py-8">
          <PageHeader title="Pay sweep" />
          <Card>
            <ErrorState category={problem ?? "unknown"} />
          </Card>
        </div>
      )}
    </AppShell>
  );
}
