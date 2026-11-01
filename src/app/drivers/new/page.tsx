import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { FeatureOff } from "@/components/app/states";
import { Card, CardBody } from "@/components/ui/card";
import { advancesOn } from "@/lib/advances/switches";
import { DbError } from "@/lib/db";
import { driverAdminOn } from "@/lib/drivers/switch";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";
import { DriverForm } from "./driver-form";

export const dynamic = "force-dynamic";

type View = { shell: ShellTenant; today: string };

// Add a driver: an admin's form, while the driver admin switch is on. The route checks the switch,
// the role and every field again, so this page only decides what to show. A new driver lands on
// their own page, not armed and with no card.
export default async function NewDriverPage() {
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      return { shell, today: carrierToday(shell.timezone, new Date()) };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;

  // The route posts through bodyAction (src/lib/advances/http.ts), which also gates on the advances
  // switch, so the form shows only while both are on; otherwise every send would be refused.
  const on = driverAdminOn() && advancesOn();
  return (
    <SignedInPage tenant={view.shell} current="/drivers" title="Add a driver">
      <PageHeader
        title="Add a driver"
        description="Who they are, how they are paid and when they start. Nothing is paid until an admin adds a card and arms them."
      />
      {!on ? (
        <FeatureOff name="Adding drivers" />
      ) : view.shell.role !== "admin" ? (
        <p className="text-body text-foreground-2">Only an admin adds a driver.</p>
      ) : (
        <Card className="max-w-[720px]">
          <CardBody>
            <DriverForm today={view.today} />
          </CardBody>
        </Card>
      )}
    </SignedInPage>
  );
}
