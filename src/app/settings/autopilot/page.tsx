import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { flags } from "@/config/flags";
import { readRole } from "@/lib/auth/role";
import { DRIVER_KINDS } from "@/lib/autopilot/policy";
import { readRules, type RulesPicture } from "@/lib/autopilot/rules-admin";
import { DbError } from "@/lib/db";
import { formatLocalDate } from "@/lib/format/dates";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { PauseForm } from "./pause-form";
import { AutopilotRulesForm, type RuleRowView } from "./rules-form";
import { ADMIN_ONLY, MODE_LABELS, NEVER_ALONE_NOTE, ruleKindLabel } from "./words";

export const dynamic = "force-dynamic";

type View = { role: "admin" | "staff" | "judge"; picture: RulesPicture };

// Each kind's row: the saved rule, or for a kind with no rule yet Ask me with the kind's ceiling
// (or nothing) as the starting limits.
function rowsOf(picture: RulesPicture): RuleRowView[] {
  const saved = new Map(picture.rules.map((r) => [r.kind, r]));
  return picture.kinds.map((k) => {
    const r = saved.get(k.kind);
    const driver = DRIVER_KINDS.has(k.kind);
    return {
      kind: k.kind,
      mode: k.mode,
      allowedAuto: k.allowedAuto,
      armed: k.armed,
      driver,
      maxCents: r?.maxCents ?? k.ceiling?.maxCents ?? 0,
      dayMaxCents: r?.dayMaxCents ?? k.ceiling?.dayMaxCents ?? 0,
      dayMaxCount: r?.dayMaxCount ?? k.ceiling?.dayMaxCount ?? 0,
      driverDayMaxCents: r ? r.driverDayMaxCents : driver ? (k.ceiling?.driverDayMaxCents ?? 0) : null,
      version: r?.version ?? null,
    };
  });
}

function pauseLine(p: RulesPicture["pause"]): string {
  if (flags.autopilot.enabled !== true) return "The autopilot is off for every carrier. A person decides everything.";
  if (!p.paused) return "Running. It approves only what the rules below allow, and asks a person about the rest.";
  if (p.pausedBy === "demo_reset") return "Paused for a short while after the demo reset. It resumes by itself.";
  return "Paused. A person decides everything until an admin resumes it.";
}

// Settings > Autopilot: per kind of work, Off, Ask me or Auto and the limits Auto stays inside,
// plus the pause. An admin saves; staff and demo visitors read. Off (flags.autopilotRules) the
// page does not exist. Signed out: withRequestTenant redirects.
export default async function AutopilotSettings() {
  if (flags.autopilotRules.enabled !== true) notFound();
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant<View>(async (q, session) => {
      const role = await readRole(q, session);
      return { role, picture: await readRules(q, Date.now()) };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[960px] gap-6">
        <Link href="/" aria-label="LedgerLine home" className="justify-self-center rounded-md">
          <Wordmark size="lg" />
        </Link>
        <h1 className="text-h2 text-foreground">Autopilot</h1>
        {view === null ? (
          <Card>
            <ErrorState category={problem === "forbidden" ? "forbidden" : "unreadable"} />
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <div className="grid gap-0.5">
                  <CardTitle>Pause autopilot</CardTitle>
                  <CardDescription>
                    {`${pauseLine(view.picture.pause)} It approves nothing made before ${formatLocalDate(view.picture.startDate)}.`}
                  </CardDescription>
                </div>
              </CardHeader>
              {flags.autopilot.enabled === true && view.role !== "judge" ? (
                <CardBody>
                  <PauseForm
                    paused={view.picture.pause.paused}
                    pausedUntil={view.picture.pause.pausedUntil}
                    canResume={view.role === "admin"}
                  />
                </CardBody>
              ) : null}
            </Card>
            <Card>
              <CardHeader>
                <div className="grid gap-0.5">
                  <CardTitle>Rules</CardTitle>
                  <CardDescription>
                    {"Off: nobody is asked. Ask me: a person decides. Auto: the autopilot approves by itself, " +
                      "only inside these limits, after every check passes. A change applies to work decided from " +
                      "now on, and every change is recorded."}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardBody className="grid gap-3">
                {view.role === "admin" ? (
                  <AutopilotRulesForm rows={rowsOf(view.picture)} />
                ) : (
                  <>
                    <p className="text-body text-foreground-2">{ADMIN_ONLY}</p>
                    <div className="overflow-x-auto">
                      <Table>
                        <THead>
                          <Tr>
                            <Th>Work</Th>
                            <Th>Rule</Th>
                          </Tr>
                        </THead>
                        <TBody>
                          {view.picture.kinds.map((k) => (
                            <Tr key={k.kind}>
                              <Td>{ruleKindLabel(k.kind)}</Td>
                              <Td>{k.allowedAuto ? MODE_LABELS[k.mode] : `${MODE_LABELS[k.mode]}. ${NEVER_ALONE_NOTE}`}</Td>
                            </Tr>
                          ))}
                        </TBody>
                      </Table>
                    </div>
                  </>
                )}
              </CardBody>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
