"use client";

import Link from "next/link";
import { useCallback } from "react";
import { HowWorkedOut, fetchTraceAt, type TraceLoader } from "@/components/trace/how-worked-out";
import { Card } from "@/components/ui/card";
import { codeToWords, recordLabel } from "@/lib/format/labels";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import type { FanoutCheckView, FanoutTree } from "@/lib/sweep/fanout/tree";

// "How the week was checked" on a sweep run's page (design 3.8): the server's agreement line, the
// comparison's summary and disagreements, then each driver's second check folded away, every node
// with its own "How this was worked out". Every number is the server's count; model text was
// checked for figures twice (when it was stored and when it was read) and renders as text only.

const PRIORITY: Readonly<Record<number, string>> = { 1: "High priority", 2: "Medium priority", 3: "Low priority" };

const NOTE: Readonly<Record<string, string>> = {
  skipped_daily_cap: "Skipped this run: the day's limit for second checks was reached.",
  plan_skipped: "The step that orders the drivers did not answer, so they were checked in the usual order.",
  plan_budget: "The step that orders the drivers was over budget, so they were checked in the usual order.",
};

const WORKING: Readonly<Record<string, string>> = {
  planning: "Ordering the drivers...",
  checking: "Checking each driver's week...",
  reconciling: "Comparing the two checks...",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function who(d: { driverCode: string | null; driverLabel: string | null }): string {
  if (d.driverCode && d.driverLabel) return `${d.driverCode}, ${d.driverLabel}`;
  return d.driverCode ?? d.driverLabel ?? "A driver";
}

function statusWord(c: FanoutCheckView, running: boolean): string {
  switch (c.status) {
    case "done":
      return c.issues.length === 0 ? "Checked, nothing else found" : `Checked, ${plural(c.issues.length, "thing", "things")} to look at`;
    case "timed_out":
      return "Timed out";
    case "budget":
      return "Over budget";
    case "unparsed":
      return "No clear answer";
    case "running":
      return running ? "Checking" : "Not checked";
    case "queued":
      return running ? "Waiting" : "Not checked";
    default:
      return "Not checked";
  }
}

// The agreement line, in the server's counts only.
function agreement(tree: FanoutTree): string | null {
  const c = tree.reconcile.counts;
  if (!c) return null;
  const all = c.drivers_checked + c.drivers_unchecked;
  if (all === 0) return "No driver had records to check a second time.";
  const lines = [`${c.drivers_checked} of ${plural(all, "driver", "drivers")} checked a second time.`];
  if (c.drivers_checked === 0) return lines[0];
  lines.push(
    c.engine === 0
      ? "Your pay rules found no problems for these drivers."
      : `The second check also found ${c.agreed} of the ${plural(c.engine, "problem", "problems")} your pay rules found.`,
  );
  lines.push(
    c.spark_only === 0
      ? "It found nothing your pay rules did not."
      : `It noticed ${c.spark_only} more your pay rules did not; ${c.spark_only === 1 ? "it is" : "they are"} under Needs a person.`,
  );
  return lines.join(" ");
}

export function WeekChecks({ tree, runId, running }: { tree: FanoutTree; runId: string; running: boolean }) {
  const load: TraceLoader = useCallback(
    (turnId) => fetchTraceAt(`/api/sweeps/${encodeURIComponent(runId)}/trace/${encodeURIComponent(turnId)}`),
    [runId],
  );
  const note = NOTE[tree.status];
  const line = agreement(tree);
  const working = !tree.finished && running ? (WORKING[tree.status] ?? WORKING.checking) : undefined;
  const stopped = !tree.finished && !running;

  return (
    <section aria-labelledby="week-checks" className="grid gap-3">
      <h3 id="week-checks" className="text-h3 text-foreground">
        How the week was checked
      </h3>
      {note ? (
        <p role="note" className="text-body text-foreground-2">
          {note}
        </p>
      ) : null}
      {line ? <p className="text-body text-foreground">{line}</p> : null}
      {working ? (
        <p role="status" className="text-body text-foreground-2">
          {working}
        </p>
      ) : null}
      {stopped && tree.status !== "skipped_daily_cap" ? (
        <p className="text-body text-foreground-2">The second check stopped before it finished.</p>
      ) : null}
      {tree.finished && tree.status !== "skipped_daily_cap" && tree.reconcile.counts ? (
        <p className="text-body text-foreground-2">
          {tree.reconcile.summary ? (
            <>
              <span className="font-semibold">Muse Wonder:</span> {tree.reconcile.summary}
            </>
          ) : (
            "No summary this run."
          )}
        </p>
      ) : null}
      {tree.reconcile.disagreements.length > 0 ? (
        <ul aria-label="Where the two checks differ" className="grid gap-1.5">
          {tree.reconcile.disagreements.map((d, n) => (
            <li key={`${d.driverId}:${d.category}:${n}`} className="text-body text-foreground">
              <span className="font-semibold">{who(d)}</span> ({codeToWords(d.category).toLowerCase()}): {d.text}
            </li>
          ))}
        </ul>
      ) : null}

      {tree.status !== "skipped_daily_cap" && (tree.checks.length > 0 || tree.plan.turnId || tree.reconcile.turnId) ? (
        <details className="rounded-lg border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-body font-semibold text-foreground">
            Each driver&apos;s check ({tree.checks.length})
          </summary>
          <div className="mt-3 grid gap-3">
            {tree.plan.turnId || tree.plan.summary ? (
              <Card className="grid gap-1.5 px-4 py-3 sm:px-5">
                <p className="text-body font-semibold text-foreground">Ordering the drivers</p>
                {tree.plan.summary ? (
                  <p className="text-small text-foreground-2">
                    <span className="font-semibold">Muse Wonder:</span> {tree.plan.summary}
                  </p>
                ) : null}
                {tree.plan.turnId ? <HowWorkedOut turnId={tree.plan.turnId} load={load} /> : null}
              </Card>
            ) : null}
            {tree.checks.length === 0 ? (
              <p className="text-body text-foreground-2">No driver had records to check this week.</p>
            ) : (
              <ul aria-label="Each driver's check" className="grid gap-3">
                {tree.checks.map((c) => (
                  <li key={c.driverId}>
                    <DriverCheck check={c} running={running} load={load} />
                  </li>
                ))}
              </ul>
            )}
            {tree.skipped.length > 0 ? (
              <p className="text-small text-foreground-2">
                Not checked a second time, past this run&apos;s limit of drivers:{" "}
                {tree.skipped.map((s) => who(s)).join("; ")}.
              </p>
            ) : null}
            {tree.reconcile.turnId ? (
              <Card className="grid gap-1.5 px-4 py-3 sm:px-5">
                <p className="text-body font-semibold text-foreground">Comparing the two checks</p>
                <HowWorkedOut turnId={tree.reconcile.turnId} load={load} />
              </Card>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DriverCheck({ check, running, load }: { check: FanoutCheckView; running: boolean; load: TraceLoader }) {
  return (
    <Card className="grid gap-1.5 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-body font-semibold text-foreground">{who(check)}</span>
        <span className="text-small text-foreground-2">
          {PRIORITY[check.priority] ?? "Low priority"} · {statusWord(check, running)}
        </span>
      </div>
      {check.brief ? <p className="text-small text-foreground-2">What to look at: {check.brief}</p> : null}
      {check.issues.length > 0 ? (
        <ul className="grid gap-1.5">
          {check.issues.map((issue, n) => (
            <li key={`${issue.category}:${n}`} className="grid gap-0.5">
              <span className="text-small text-foreground">
                <span className="font-semibold">{codeToWords(issue.category)}:</span> {issue.note}
              </span>
              <span className="flex flex-wrap gap-x-3 text-small">
                {issue.sources.map((r) => {
                  const href = hrefOrNull(recordHref, r);
                  return href ? (
                    <Link key={`${r.table}:${r.id}`} href={href} className="text-link underline-offset-4 hover:underline">
                      {recordLabel(r)}
                    </Link>
                  ) : (
                    <span key={`${r.table}:${r.id}`} className="text-foreground-2">
                      {recordLabel(r)}
                    </span>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {check.turnId ? <HowWorkedOut turnId={check.turnId} load={load} /> : null}
    </Card>
  );
}
