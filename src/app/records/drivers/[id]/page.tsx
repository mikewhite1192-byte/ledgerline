import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Day, Facts, RecordLink } from "@/components/invoices/cells";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { readDriverIdentity, type DriverIdentity } from "@/lib/advances/identity";
import { advancesOn } from "@/lib/advances/switches";
import { readRole } from "@/lib/auth/role";
import { driverAdminOn } from "@/lib/drivers/switch";
import { formatPeriod } from "@/lib/format/dates";
import { codeToWords } from "@/lib/format/labels";
import { readDriverRecord } from "@/lib/settlements/views";
import { readRecordPage } from "../../read-record";
import { DriverMoney } from "./money-panel";

export const dynamic = "force-dynamic";

const WORKER = { company: "Company driver", owner_operator: "Owner-operator" } as const;

// While driver admin is on (so a just-added driver lands here): the one-line cue above the money
// panel naming only the steps still missing before an advance (an active card, then arming).
function setupCue(identity: DriverIdentity): string | null {
  if (!driverAdminOn()) return null;
  const noCard = !identity.cards.some((c) => c.status === "active");
  const notArmed = !identity.armed.on;
  if (noCard && notArmed) return "Before this driver can take an advance: add a card, then arm them.";
  if (noCard) return "Before this driver can take an advance: add a card.";
  if (notArmed) return "Before this driver can take an advance: arm them.";
  return null;
}

// One driver: who they are and how they are paid, their recent paystubs and advances. Every
// paystub line cites its driver, so this is where those links land. While advances are on, the
// money panel too (armed, the ids other systems know them by, the cards on file, and while
// driver admin is on the driver's status), and each advance links to its record.
export default async function DriverRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await readRecordPage(id, async (q, driverId, today, session) => {
    const record = await readDriverRecord(q, driverId);
    if (record === null) return null;
    if (!advancesOn()) return { record, advanceLinks: false, money: null };
    const identity = await readDriverIdentity(q, driverId);
    // Read only: any member's role, a demo visitor's too (its writes are refused on the routes).
    const role = await readRole(q, session);
    return { record, advanceLinks: true, money: identity ? { identity, canAdmin: role === "admin", today } : null };
  });
  if (page.kind === "problem") return <NoCarrierPage problem={page.problem} />;
  if (page.kind === "missing") {
    return (
      <SignedInPage tenant={page.shell} current="none" title="Driver">
        <ErrorState category="not_found" />
      </SignedInPage>
    );
  }
  const { record: d, advanceLinks, money } = page.record;
  const cue = money ? setupCue(money.identity) : null;
  return (
    <SignedInPage tenant={page.shell} current="none" title={d.name} focus={{ table: "drivers", id: d.id, label: d.name }}>
      <PageHeader
        title={d.name}
        description={d.code}
        actions={d.ownInsurance ? <Badge tone="info">Carries own insurance</Badge> : undefined}
      />
      {cue ? <p className="text-body text-foreground-2">{cue}</p> : null}
      {money ? (
        <DriverMoney
          identity={money.identity}
          canAdmin={money.canAdmin}
          timezone={page.shell.timezone}
          statusAdminOn={driverAdminOn()}
          today={money.today}
        />
      ) : null}
      <Card>
        <CardBody>
          <Facts
            items={[
              { label: "Type", value: WORKER[d.workerType] },
              { label: "Paid by", value: codeToWords(d.payBasis) },
              { label: "Escrow balance", value: <Money cents={d.escrowBalanceCents} tone="plain" /> },
              { label: "Insurance", value: d.ownInsurance ? "Carries own insurance" : "Carrier's policy" },
              { label: "Active from", value: <Day value={d.activeFrom} /> },
              { label: "Active to", value: d.activeTo ? <Day value={d.activeTo} /> : "Still active" },
            ]}
          />
        </CardBody>
      </Card>
      <DataTable
        caption="Paystubs, newest first"
        rows={d.settlements}
        rowKey={(s) => s.id}
        empty={{ title: "No paystubs yet" }}
        columns={[
          {
            key: "week",
            header: "Week",
            cell: (s) => (
              <RecordLink table="settlements" id={s.id}>
                {formatPeriod(s.periodStart, s.periodEnd)}
              </RecordLink>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (s) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={s.status} />
                {s.parked ? <Badge tone="warning">Parked</Badge> : null}
              </span>
            ),
          },
          { key: "net", header: "Net", align: "right", cell: (s) => <Money cents={s.netCents} tone="plain" /> },
        ]}
      />
      <DataTable
        caption="Advances, newest first"
        rows={d.advances}
        rowKey={(a) => a.id}
        empty={{ title: "No advances" }}
        columns={[
          {
            key: "on",
            header: "Requested",
            cell: (a) =>
              advanceLinks ? (
                <RecordLink table="advances" id={a.id}>
                  <Day value={a.requestedOn} />
                </RecordLink>
              ) : (
                <Day value={a.requestedOn} />
              ),
          },
          { key: "status", header: "Status", cell: (a) => <StatusBadge status={a.status} /> },
          { key: "amount", header: "Amount", align: "right", cell: (a) => <Money cents={a.amountCents} tone="plain" /> },
          { key: "recovered", header: "Recovered", align: "right", cell: (a) => <Money cents={a.recoveredCents} tone="plain" /> },
        ]}
      />
    </SignedInPage>
  );
}
