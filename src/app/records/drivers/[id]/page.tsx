import Link from "next/link";
import { notFound } from "next/navigation";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdvanceFrame, problemOf, ReadFailed, type ReadProblem } from "@/app/advances/frame";
import { readDriverIdentity, type DriverIdentity } from "@/lib/advances/identity";
import { readMember } from "@/lib/advances/member";
import { readDriverAdvances, readShell, type DriverAdvance, type Shell } from "@/lib/advances/read";
import { advancesOn } from "@/lib/advances/switches";
import { formatLocalDate } from "@/lib/format/dates";
import { isUuid } from "@/lib/uuid";
import { withRequestTenant } from "@/lib/tenant/context";
import { DriverMoney } from "./money-panel";

export const dynamic = "force-dynamic";

// One driver: name, code, whether they still drive here, the money panel (armed, the ids other
// systems know them by, the cards on file) and their open or paid advances. A missing id and
// another carrier's id read the same "not here".
export default async function DriverRecordPage({ params }: { params: Promise<{ id: string }> }) {
  if (!advancesOn()) notFound();
  const { id: raw } = await params;
  const id = isUuid(raw) ? raw.toLowerCase() : null;

  let page: {
    shell: Shell;
    identity: DriverIdentity | null;
    canAdmin: boolean;
    advances: DriverAdvance[];
  } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => {
      const shell = await readShell(q, session);
      const member = await readMember(q, session);
      const identity = id ? await readDriverIdentity(q, id) : null;
      return {
        shell,
        identity,
        canAdmin: member.role === "admin",
        advances: identity ? await readDriverAdvances(q, identity.driverId) : [],
      };
    });
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <ReadFailed problem={problem ?? "unreadable"} />;
  const { shell, identity, canAdmin, advances } = page;
  if (!identity) {
    return (
      <AdvanceFrame shell={shell} title="Driver">
        <Card>
          <ErrorState category="not_found" retry={<Link href="/advances" className="text-link underline-offset-4 hover:underline">All advances</Link>} />
        </Card>
      </AdvanceFrame>
    );
  }
  return (
    <AdvanceFrame shell={shell} title={identity.name}>
      <PageHeader
        title={identity.name}
        description={`Driver ${identity.code} · ${identity.activeTo ? `drove here until ${formatLocalDate(identity.activeTo)}` : "active"}`}
      />
      <DriverMoney identity={identity} canAdmin={canAdmin} timezone={shell.timezone} />
      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>Advances</CardTitle>
            <CardDescription>Open and paid advances for this driver, newest first.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {advances.length === 0 ? (
            <p className="text-body text-foreground-2">No open or paid advances.</p>
          ) : (
            <ul className="grid gap-2">
              {advances.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 text-body text-foreground">
                  <Link href={`/records/advances/${a.id}`} className="text-link underline-offset-4 hover:underline">
                    {a.requestRef}
                  </Link>
                  <Money cents={a.amountCents} />
                  <span className="text-small text-muted-foreground">{formatLocalDate(a.requestedOn)}</span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </AdvanceFrame>
  );
}
