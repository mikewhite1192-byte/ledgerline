import Link from "next/link";
import { notFound } from "next/navigation";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { Paystub } from "@/components/app/paystub";
import { ErrorState, FeatureOff } from "@/components/app/states";
import { Card, CardBody } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { readDriverView, type DriverView } from "@/lib/driver-notes/view";
import { withRequestTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";
import {
  readShell,
  shellProblemOf,
  ShellProblemPage,
  SignOutForm,
  type ShellInfo,
  type ShellProblem,
} from "../../../shell";

export const dynamic = "force-dynamic";

// The record pages arrive with later items, so the paystub here shows each line's records as
// names, not links (a RangeError is the link rules' refusal).
function noRecordLinks(): string {
  throw new RangeError("record pages are not built yet");
}

// What the driver sees for one paystub: the approved note above it, the short pay line when the
// note failed the check or was rejected, and nothing extra before a person approves a note.
export default async function DriverViewPage({ params }: { params: Promise<{ settlementId: string }> }) {
  const { settlementId } = await params;
  if (!isUuid(settlementId)) notFound();

  let data: { shell: ShellInfo; view: DriverView | null } | null = null;
  let problem: ShellProblem | null = null;
  try {
    data = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      view: flags.driverNotesEnabled ? await readDriverView(q, settlementId) : null,
    }));
  } catch (err) {
    problem = shellProblemOf(err);
  }
  if (!data) return <ShellProblemPage problem={problem ?? "unreadable"} />;
  const { shell, view } = data;

  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone }}
      nav={appNav("/driver-notes")}
      title="Driver notes"
      signOut={<SignOutForm />}
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-6">
        {!flags.driverNotesEnabled ? (
          <>
            <PageHeader title="Driver note" />
            <Card>
              <FeatureOff name="Driver notes" plural />
            </Card>
          </>
        ) : !view ? (
          <>
            <PageHeader title="Driver note" />
            <Card>
              <ErrorState category="not_found" />
            </Card>
          </>
        ) : (
          <>
            <Link
              href={`/pay/${view.source.period.id}/notes`}
              className="w-fit text-small text-link underline-offset-4 hover:underline"
            >
              Back to this period&apos;s notes
            </Link>
            <PageHeader
              title="What the driver sees"
              description={`${view.source.driver.first_name} ${view.source.driver.last_name} sees this with their paystub.`}
            />
            {view.message ? (
              <Card>
                <CardBody className="grid gap-1.5">
                  <p className="text-small font-medium text-foreground-2">
                    {view.message.kind === "note" ? "Note about this pay" : "About this pay"}
                  </p>
                  <p
                    lang={view.message.language}
                    className="text-body whitespace-pre-line text-foreground"
                  >
                    {view.message.body}
                  </p>
                </CardBody>
              </Card>
            ) : (
              <p className="text-body text-foreground-2">No approved note yet, so the driver sees the paystub alone.</p>
            )}
            <Paystub
              driver={{
                name: `${view.source.driver.first_name} ${view.source.driver.last_name}`,
                code: view.source.driver.code,
                workerType: view.source.driver.worker_type,
              }}
              period={{ start: view.source.period.period_start, end: view.source.period.period_end }}
              status={view.source.settlement.status}
              lines={view.source.lines.map((l) => ({
                seq: l.seq,
                kind: l.kind,
                label: l.label,
                amountCents: l.amount_cents,
                sources: l.sources,
              }))}
              grossCents={view.source.settlement.gross_cents}
              deductionsCents={view.source.settlement.deductions_cents}
              netCents={view.source.settlement.net_cents}
              carryForwardCents={view.source.settlement.carry_forward_cents}
              exceptions={[]}
              hrefFor={noRecordLinks}
              lineIdPrefix="line-"
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
