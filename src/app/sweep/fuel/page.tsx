import { notFound } from "next/navigation";
import { flags } from "@/config/flags";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { FuelChecks } from "@/components/fuel/fuel-checks";
import { Card } from "@/components/ui/card";
import { FUEL_PAGE_WORDS } from "@/lib/fuel/help";
import { readFuelPage, type FuelPage } from "@/lib/fuel/view";
import { NoCarrier, readCarrier, SignOut } from "../carrier";

// The fuel checks page (FUEL-ANOMALY design 4.6), under the Sweep entry: the last check's line,
// the button that checks the fill-ups again, and one row per problem. Off when the switch is off.
export const dynamic = "force-dynamic";

export default async function FuelChecksPage() {
  if (!flags.fuelAnomalyEnabled) notFound();
  const read = await readCarrier();
  if ("problem" in read) return <NoCarrier problem={read.problem} />;
  const { carrier } = read;

  // Unknown is not empty: a failed read shows the error, never "no fuel problems".
  let page: FuelPage | null = null;
  try {
    page = await readFuelPage(carrier.session);
  } catch (err) {
    console.error("fuel checks read failed:", err instanceof Error ? err.name : "unknown");
  }

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/sweep")}
      title={FUEL_PAGE_WORDS.title}
      signOut={<SignOut />}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6 px-4 py-6 md:px-6 md:py-8">
        <PageHeader title={FUEL_PAGE_WORDS.title} description={FUEL_PAGE_WORDS.subtitle} />
        {page === null ? (
          <Card>
            <ErrorState category="unreadable" />
          </Card>
        ) : (
          <FuelChecks page={page} auditorOn={flags.auditorEnabled} timezone={carrier.timezone} />
        )}
      </div>
    </AppShell>
  );
}
