import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { flags } from "@/config/flags";
import type { DemoFaults } from "@/lib/adapters/tms-source/faults";
import { TENANT_TABLES, type TenantTable } from "@/lib/data/tables";
import { DbError } from "@/lib/db";
import { formatLocalDate } from "@/lib/format/dates";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { buildCarrierPlan } from "@/lib/seed/plan";
import { RESET_TABLES, TABLE_LABELS, demoCarrierOf, previewDemoReset, refusalText } from "@/lib/seed/reset";
import { countRows } from "@/lib/seed/summary";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readFaultSettings } from "@/lib/tms/demo-faults";
import { MoveFleetForm } from "./fleet-form";
import { DemoResetForm } from "./reset-form";
import { TmsFaultsForm } from "./tms-faults-form";
import { TmsSyncForm } from "./tms-sync-form";
import { TmsWakeUpForm } from "./tms-wakeup-form";

export const dynamic = "force-dynamic";

type Row = { table: string; label: string; now: number; after: number };
type View =
  | { kind: "staff" }
  | { kind: "not_demo" }
  | { kind: "ready"; name: string; rows: Row[]; refusals: string[]; faults: DemoFaults | null };

const isTenantTable = (t: string): t is TenantTable => (TENANT_TABLES as readonly string[]).includes(t);

// What is kept, in plain words (DEMO_RESET_KEPT in src/lib/seed/reset.ts holds the full list).
const KEPT = [
  "the carrier itself and every login",
  "the record of model charges, the model spend alerts and the agent's safety check log",
  "the QuickBooks sandbox link",
];

// The demo reset: a demo carrier's admin sees what the carrier holds now and what a reset leaves,
// then confirms. Off (flags.demoResetEnabled) the page does not exist. Signed out:
// withRequestTenant redirects.
export default async function DemoSettings() {
  if (!flags.demoResetEnabled) notFound();
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant<View>(async (q, session) => {
      const members = await q.query<{ role: string }>(
        "SELECT role FROM memberships WHERE cognito_sub = $1",
        [session.sub],
      );
      if (members.length !== 1) throw new ForbiddenError();
      if (members[0].role !== "admin") return { kind: "staff" };
      const carrier = await demoCarrierOf(q);
      if (!carrier) return { kind: "not_demo" };
      const preview = await previewDemoReset(q, carrier);
      const planned = countRows(buildCarrierPlan(carrier, DEMO_ANCHOR).rows);
      // The fault switches show only while their switch is on and the carrier reads the synthetic feed.
      const faultSettings = flags.tmsSync.demoFaultsEnabled === true ? await readFaultSettings(q) : null;
      return {
        kind: "ready",
        name: carrier.name,
        rows: RESET_TABLES.map((t) => ({
          table: t,
          label: TABLE_LABELS[t],
          now: preview.current[t],
          after: isTenantTable(t) ? planned[t] : 0,
        })),
        refusals: preview.refusals.map(refusalText),
        faults: faultSettings?.kind === "ok" ? faultSettings.faults : null,
      };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[640px] gap-6">
        <Link href="/" aria-label="LedgerLine home" className="justify-self-center rounded-md">
          <Wordmark size="lg" />
        </Link>
        <h1 className="text-h2 text-foreground">Demo reset</h1>
        <Card>
          {view?.kind === "ready" ? (
            <>
              <CardHeader>
                <div className="grid gap-0.5">
                  <CardTitle>{`Put ${view.name} back to its seeded week`}</CardTitle>
                  <CardDescription>
                    {`Every seeded record is rewritten exactly as the seed writes it for ${formatLocalDate(DEMO_ANCHOR)}. ` +
                      "The agent's conversations and cards, uploaded documents, voice notes, driver notes, " +
                      "and settled test-mode payouts and bookings are deleted. " +
                      "It all happens at once: if any step fails, nothing changes."}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardBody className="grid gap-5">
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <Tr>
                        <Th>Records</Th>
                        <Th align="right">Now</Th>
                        <Th align="right">After the reset</Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {view.rows.map((r) => (
                        <Tr key={r.table}>
                          <Td>{r.label}</Td>
                          <Td align="right">{r.now.toLocaleString("en-US")}</Td>
                          <Td align="right">{r.after.toLocaleString("en-US")}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <p className="text-body text-foreground-2">{`Kept as they are: ${KEPT.join("; ")}.`}</p>
                {view.refusals.length > 0 ? (
                  <InlineAlert tone="warning" title="The reset is blocked until a person settles these">
                    <ul className="list-disc pl-5">
                      {view.refusals.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </InlineAlert>
                ) : (
                  <DemoResetForm />
                )}
              </CardBody>
            </>
          ) : view?.kind === "staff" ? (
            <CardBody>
              <p className="text-body text-foreground-2">Only an admin of this carrier can reset the demo.</p>
            </CardBody>
          ) : view?.kind === "not_demo" ? (
            <CardBody>
              <p className="text-body text-foreground-2">
                This carrier is not a demo carrier. The reset works only on the demo carriers.
              </p>
            </CardBody>
          ) : (
            <ErrorState category={problem === "forbidden" ? "forbidden" : "unreadable"} />
          )}
        </Card>
        {view?.kind === "ready" ? (
          <Card>
            <CardHeader>
              <div className="grid gap-0.5">
                <CardTitle>Move the fleet</CardTitle>
                <CardDescription>
                  {"The stand-in for a dispatch feed. Each press moves up to three loads one step: a load " +
                    "whose pickup day has come is picked up, and a load picked up before today is delivered " +
                    "today. The hero driver's loads are left for the walk-through. No money moves."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <MoveFleetForm />
            </CardBody>
          </Card>
        ) : null}
        {view?.kind === "ready" && flags.tmsSync.enabled ? (
          <Card>
            <CardHeader>
              <div className="grid gap-0.5">
                <CardTitle>Sync dispatch now</CardTitle>
                <CardDescription>
                  {"Reads the demo dispatch system once, the same pull the desk makes on each wake, and " +
                    "keeps what it finds in the dispatch mirror. It only reads. A load moves when the desk " +
                    "sees a new status and its own switches are on. No money moves."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <TmsSyncForm />
            </CardBody>
          </Card>
        ) : null}
        {view?.kind === "ready" && view.faults !== null && flags.tmsSync.demoFaultsEnabled === true ? (
          <Card>
            <CardHeader>
              <div className="grid gap-0.5">
                <CardTitle>Dispatch faults</CardTitle>
                <CardDescription>
                  {"Makes the demo dispatch system act like a messy real one, one fault per switch, so the " +
                    "sync can be seen coping. Each switch saves at once and the next sync reads the feed with " +
                    "it. Only the demo feed changes. No money moves."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <TmsFaultsForm initial={view.faults} />
              {flags.tmsHook.enabled === true && flags.tmsSync.enabled === true ? (
                <div className="mt-4">
                  <TmsWakeUpForm />
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
