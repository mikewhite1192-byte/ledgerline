import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState, FeatureOff } from "@/components/app/states";
import { RatesBoard } from "@/components/rates/rates-board";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { DbError } from "@/lib/db";
import { readRatesPage, type RatesPage } from "@/lib/rates/read";
import { RATES_WORDS as W } from "@/lib/rates/words";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

// Settings, "Fuel and tax rates" (GROUNDED-RATES design 4.8): the diesel price and each crossed
// state's fuel tax rate, pinned or not, with the latest lookup and its source. Any staff member
// may look one up; only an admin pins. Off when the switch is off, and nothing is read then.
export const dynamic = "force-dynamic";

export default async function RatesSettings() {
  const on = flags.groundedRatesEnabled;
  let shell: ShellTenant | null = null;
  // Unknown is not empty: a rates read that fails shows the error, never "nothing pinned".
  let page: RatesPage | "unreadable" | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    shell = await withRequestTenant(async (q, session) => {
      const found = await readShell(q, session);
      if (on) {
        try {
          page = await readRatesPage(q, session.sub, new Date());
        } catch (err) {
          console.error(`rates page read failed: ${err instanceof Error ? err.name : "unknown"}`);
          page = "unreadable";
        }
        if (page === null) throw new ForbiddenError();
      }
      return found;
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  if (!shell) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const view = page as RatesPage | "unreadable" | null;

  return (
    <SignedInPage tenant={shell} current={on ? "/settings/rates" : "none"} title={W.title}>
      <PageHeader title={W.title} description={on ? W.subtitle : undefined} />
      {!on ? (
        <Card>
          <FeatureOff name={W.title} plural />
        </Card>
      ) : view === "unreadable" || view === null ? (
        <Card>
          <ErrorState category="unreadable" />
        </Card>
      ) : (
        <RatesBoard page={view} />
      )}
    </SignedInPage>
  );
}
