import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { flags } from "@/config/flags";
import { DRIVER_KINDS } from "@/lib/autopilot/policy";
import { readRules, type RulesPicture } from "@/lib/autopilot/rules-admin";
import { DbError } from "@/lib/db";
import { formatLocalDate } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";
import { PauseForm } from "./pause-form";
import { AutopilotRulesForm, type RuleRowView } from "./rules-form";
import { ADMIN_ONLY, LIMIT_LABELS, MODE_LABELS, ruleKindLabel, ruleNote } from "./words";

export const dynamic = "force-dynamic";

type View = { shell: ShellTenant; role: ShellTenant["role"]; picture: RulesPicture };

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
// plus the pause, inside the signed-in shell under Settings. An admin saves; staff and demo
// visitors read. Off (flags.autopilotRules) the page does not exist. Signed out:
// withRequestTenant redirects.
export default async function AutopilotSettings() {
  if (flags.autopilotRules.enabled !== true) notFound();
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant<View>(async (q, session) => {
      const shell = await readShell(q, session);
      return { shell, role: shell.role, picture: await readRules(q, Date.now()) };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  if (view === null) return <NoCarrierPage problem={problem ?? "unreadable"} />;

  return (
    <SignedInPage tenant={view.shell} current="/settings" title="Autopilot">
      <PageHeader title="Autopilot" description="What the autopilot may approve by itself, and the switch that pauses it." />
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
              revision={view.picture.pause.revision}
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
                      <Th>{LIMIT_LABELS.maxCents}</Th>
                      <Th>{LIMIT_LABELS.dayMaxCents}</Th>
                      <Th>{LIMIT_LABELS.dayMaxCount}</Th>
                      <Th>{LIMIT_LABELS.driverDayMaxCents}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {/* The same rows, limits and notes the admin form shows, read only. */}
                    {rowsOf(view.picture).map((r) => {
                      const note = ruleNote(r);
                      return (
                        <Tr key={r.kind}>
                          <Td>{ruleKindLabel(r.kind)}</Td>
                          <Td>{note === null ? MODE_LABELS[r.mode] : `${MODE_LABELS[r.mode]}. ${note}`}</Td>
                          <Td>{formatCents(r.maxCents)}</Td>
                          <Td>{formatCents(r.dayMaxCents)}</Td>
                          <Td>{r.dayMaxCount}</Td>
                          <Td>{r.driverDayMaxCents === null ? "" : formatCents(r.driverDayMaxCents)}</Td>
                        </Tr>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </SignedInPage>
  );
}
