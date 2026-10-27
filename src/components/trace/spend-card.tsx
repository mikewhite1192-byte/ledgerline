import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInstant } from "@/lib/format/dates";
import { countWords, formatSpend } from "@/lib/trace/format";

// The Meta models page's Spend card: the demo budget and Muse Wonder's share of it (both shared by
// every carrier), this carrier's last 24 hours, the hourly allowance of one job, and the jobs the
// spend watch stopped, with a Clear control on each open one for an admin. Plain data in, no reads.

export type Budget = { spentNanocents: number; capNanocents: number | null };

// The same shapes the spend watch reads (src/lib/ai/watch.ts), declared here because a shared
// component never imports model code.
export type DaySpend = { spentNanocents: number; calls: number };

export type SpendAlert = {
  id: string;
  traceId: string | null;
  purpose: string;
  spentNanocents: number;
  limitNanocents: number;
  // ISO instants (UTC).
  createdAt: string;
  clearedAt: string | null;
  clearedByEmail: string | null;
};

export type SpendCardProps = {
  demo: Budget;
  wonder: Budget;
  day: DaySpend;
  jobCapNanocents: number | null;
  alerts: SpendAlert[];
  timeZone: string;
  // The Clear control for an open alert. Unset for anyone but an admin.
  clear?: (alert: SpendAlert) => ReactNode;
};

const JOB_WORDS: Readonly<Record<string, string>> = {
  agent_operator_turn: "Chat answer",
  agent_operator_escalation: "Proposal handed to Muse Wonder",
  screen_untrusted_input: "Screening outside text",
  audit_proposal: "Auditor check",
  driver_note: "Driver note",
  proof: "Model connection check",
};

// What the stopped job was doing, from the purpose of the call that was refused.
export function jobWords(purpose: string): string {
  return Object.hasOwn(JOB_WORDS, purpose) ? JOB_WORDS[purpose] : `Model calls for ${purpose.replaceAll("_", " ")}`;
}

// Which calls make up the job: one answer's trace, or every call for the purpose with no trace.
export function jobScope(alert: Pick<SpendAlert, "traceId">): string {
  return alert.traceId ? `One answer, trace ${alert.traceId.slice(0, 8)}` : "Every call for this purpose with no trace";
}

function budgetLine(label: string, b: Budget, refused: string): string {
  return b.capNanocents === null
    ? `${label}: ${formatSpend(b.spentNanocents)}, with no cap set, so ${refused} is refused.`
    : `${label}: ${formatSpend(b.spentNanocents)} of ${formatSpend(b.capNanocents)}.`;
}

function AlertRow({ a, timeZone, clear }: { a: SpendAlert; timeZone: string; clear?: SpendCardProps["clear"] }) {
  const open = a.clearedAt === null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="grid min-w-0 gap-0.5">
        <p className="flex flex-wrap items-center gap-2 text-body font-medium text-foreground">
          {jobWords(a.purpose)}
          <Badge tone={open ? "destructive" : "neutral"}>{open ? "Stopped" : "Cleared"}</Badge>
        </p>
        <p className="text-small text-foreground-2">
          {jobScope(a)}. Would have reached {formatSpend(a.spentNanocents)} in an hour, over its{" "}
          {formatSpend(a.limitNanocents)} allowance.
        </p>
        <p className="text-small text-foreground-2">
          Stopped {formatInstant(a.createdAt, timeZone)}.
          {open
            ? " Every call of this job is refused until it is cleared."
            : ` Cleared ${a.clearedAt ? formatInstant(a.clearedAt, timeZone) : ""} by ${a.clearedByEmail ?? "an admin"}.`}
        </p>
      </div>
      {open ? (
        clear ? (
          clear(a)
        ) : (
          <p className="text-small text-foreground-2">An admin can clear it.</p>
        )
      ) : null}
    </li>
  );
}

export function SpendCard({ demo, wonder, day, jobCapNanocents, alerts, timeZone, clear }: SpendCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Spend</CardTitle>
        <CardDescription>What the models have cost, and any job that went past its hourly allowance.</CardDescription>
      </CardHeader>
      <CardBody className="grid gap-5">
        <div className="grid gap-1 text-small text-foreground-2 tabular-nums">
          <p>{budgetLine("Demo budget used, across every carrier", demo, "every call")}</p>
          <p>{budgetLine("Muse Wonder used, across every carrier", wonder, "every Muse Wonder call")}</p>
          <p>
            This carrier, last 24 hours: {formatSpend(day.spentNanocents)} across{" "}
            {countWords(day.calls, "call", "calls")}.
          </p>
          <p>
            {jobCapNanocents === null
              ? "No hourly allowance is set for a job, so every call is refused."
              : `Any one job may spend up to ${formatSpend(jobCapNanocents)} in an hour. A call that would go past it is refused, and the job stays stopped until an admin clears it here.`}
          </p>
        </div>
        <section aria-labelledby="spend-alerts-heading" className="grid gap-2">
          <h3 id="spend-alerts-heading" className="text-h3 text-foreground">
            Stopped jobs
          </h3>
          {alerts.length === 0 ? (
            <p className="text-small text-foreground-2">No job has gone past its hourly allowance.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {alerts.map((a) => (
                <AlertRow key={a.id} a={a} timeZone={timeZone} clear={clear} />
              ))}
            </ul>
          )}
        </section>
      </CardBody>
    </Card>
  );
}
