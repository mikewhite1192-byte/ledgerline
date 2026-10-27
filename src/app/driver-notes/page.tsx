import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { Card, CardBody } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { listNotePeriods, type NotePeriod } from "@/lib/driver-notes/view";
import { formatPeriod } from "@/lib/format/dates";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, shellProblemOf, ShellProblemPage, SignOutForm, type ShellInfo, type ShellProblem } from "../shell";

export const dynamic = "force-dynamic";

// The pay periods with settled pay, each linking to its notes. Every read runs inside
// withRequestTenant, so only the signed-in carrier's periods appear.
export default async function DriverNotesIndex() {
  let data: { shell: ShellInfo; periods: NotePeriod[] } | null = null;
  let problem: ShellProblem | null = null;
  try {
    data = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      periods: flags.driverNotesEnabled ? await listNotePeriods(q) : [],
    }));
  } catch (err) {
    problem = shellProblemOf(err);
  }
  if (!data) return <ShellProblemPage problem={problem ?? "unreadable"} />;
  const { shell, periods } = data;

  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone }}
      nav={appNav("/driver-notes")}
      title="Driver notes"
      signOut={<SignOutForm />}
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-6">
        <PageHeader
          title="Driver notes"
          description="A short note for each driver, in their language, that explains their pay. Every number is checked against the paystub before anyone can approve it."
        />
        {!flags.driverNotesEnabled ? (
          <Card>
            <EmptyState
              icon={<NotebookPen aria-hidden />}
              title="Driver notes are switched off"
              body="Nothing is drafted or shown to drivers until they are switched on."
            />
          </Card>
        ) : periods.length === 0 ? (
          <Card>
            <EmptyState
              icon={<NotebookPen aria-hidden />}
              title="No settled pay yet"
              body="Notes can be drafted once a pay period has approved paystubs."
            />
          </Card>
        ) : (
          <ul className="grid gap-3" aria-label="Pay periods">
            {periods.map((p) => (
              <li key={p.id}>
                <Card>
                  <CardBody className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="grid min-w-0 gap-0.5">
                      <Link
                        href={`/pay/${p.id}/notes`}
                        className="text-h3 text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
                      >
                        {formatPeriod(p.periodStart, p.periodEnd)}
                      </Link>
                      <p className="text-small text-foreground-2">
                        {countWords(p.settled, "paystub")}, {p.drafted} with a note, {p.approved} approved
                      </p>
                    </div>
                    {p.waiting > 0 ? (
                      <span className="text-small font-medium text-foreground">{p.waiting} waiting for approval</span>
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

function countWords(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}
