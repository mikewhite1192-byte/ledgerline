"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { formatInstant } from "@/lib/format/dates";
import { modelCallStatusLabel } from "@/lib/format/labels";
import { endedWords } from "@/lib/portal/words";
import { formatCallCost, formatLatency, formatSpend, targetName } from "@/lib/trace/format";
import type { CheckView, EvidenceView, RunView, StepView } from "@/lib/portal/views";
import { zoneOf } from "@/lib/portal/zones";

// One run, live: polls every 2 seconds while the run is queued, running or waiting for a person,
// and stops once it ends. Approve and decline are one click per check; there is no approve all.

const LIVE = new Set(["queued", "running", "waiting_approval"]);
const POLL_MS = 2_000;

const READBACK: Record<EvidenceView["readback"], string> = {
  matches: "matches",
  differs: "differs",
  partial: "partly matches",
};

// A step reads what was done ("Click"); where the pointer landed ("Click at 640, 410") is kept
// for the Details disclosure under it.
const PLACE = / (?:at|to) -?\d+, -?\d+$/;

export function withoutPlace(sentence: string): string {
  return sentence.replace(PLACE, "");
}

export function placesOf(sentences: string[]): string[] {
  return sentences.filter((t) => PLACE.test(t));
}

// A dock time in the dock's own zone ("Oct 20, 2026, 9:05 AM CDT"). The portal's own stamp
// ("2026-10-20 09:05 CT") is the runner's evidence format, not a person's.
function dockTime(shown: string | null, at: string | null, label: EvidenceView["zoneLabel"]): string {
  if (shown === null || at === null) return "Not on the portal";
  if (label === null) return "Time not known";
  try {
    return formatInstant(at, zoneOf(label));
  } catch {
    return "Time not known";
  }
}

function shot(runId: string, seq: number) {
  return `/api/portal-runs/${runId}/steps/${seq}/screenshot`;
}

function seconds(steps: StepView[], i: number): string | null {
  if (i === 0) return null;
  const ms = Date.parse(steps[i].createdAt) - Date.parse(steps[i - 1].createdAt);
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 1000)} s` : null;
}

function ApprovalCard({ view, onDecided }: { view: RunView; onDecided: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = view.checks.filter((c) => c.status === "pending");
  if (view.run.status !== "waiting_approval" || pending.length === 0) return null;

  async function decide(check: CheckView, decision: "approve" | "decline") {
    setBusy(`${check.id}:${decision}`);
    setProblem(null);
    try {
      const res = await fetch(`/api/portal-runs/${view.run.id}/checks/${check.id}/${decision}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (!res.ok) {
        setProblem(
          body.error === "approval_expired"
            ? "This check waited more than 30 minutes, so the run stopped."
            : body.error === "session_expired"
              ? "The portal session ended, so the run stopped."
              : body.reason === "disabled"
                ? "No runner is set up here, so the run cannot go on."
                : "Could not record the decision. Try again.",
        );
      }
    } catch {
      setProblem("Could not record the decision. Try again.");
    } finally {
      setBusy(null);
      onDecided();
    }
  }

  return (
    <Card className="border-warning">
      <CardHeader>
        <CardTitle>A safety check is waiting for you</CardTitle>
        <CardDescription>
          Nothing below has run. Approve lets the agent take these steps; decline ends the run. A check waits at most 30 minutes.
        </CardDescription>
      </CardHeader>
      <CardBody className="grid gap-6">
        {pending.map((check) => {
          const step = view.steps.find((s) => s.seq === check.stepSeq);
          const seen = view.steps.find((s) => s.seq === check.stepSeq - 1 && s.hasScreenshot);
          return (
            <div key={check.id} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              {seen ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shot(view.run.id, seen.seq)} alt="The page the agent was looking at" className="w-full rounded-md border border-border" />
              ) : (
                <p className="text-small text-muted-foreground">No screenshot for this step.</p>
              )}
              <div className="grid content-start gap-3">
                <InlineAlert tone="warning">{check.category}</InlineAlert>
                <div>
                  <p className="text-small font-medium">What the agent wants to do</p>
                  <ul className="list-disc pl-5 text-body">
                    {(step?.sentences ?? []).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => decide(check, "approve")} pending={busy === `${check.id}:approve`} disabled={busy !== null}>
                    Approve this step
                  </Button>
                  <Button variant="destructive" onClick={() => decide(check, "decline")} pending={busy === `${check.id}:decline`} disabled={busy !== null}>
                    Decline and end the run
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {problem ? <InlineAlert tone="destructive">{problem}</InlineAlert> : null}
      </CardBody>
    </Card>
  );
}

function EvidenceCard({ view }: { view: RunView }) {
  const e = view.evidence;
  if (!e) return null;
  const screening =
    e.screenVerdict === "clean" ? (
      <Badge tone="success">Screened clean</Badge>
    ) : e.screenVerdict === "flagged" ? (
      <Badge tone="warning">Flagged by screening</Badge>
    ) : (
      <Badge tone="warning">Not screened</Badge>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Evidence</CardTitle>
        <CardDescription>Times from the broker&apos;s portal, in the dock&apos;s time zone. Minutes at the dock are worked out by code, not the model.</CardDescription>
      </CardHeader>
      <CardBody className="grid gap-3">
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="text-small text-muted-foreground">Delivery check-in</dt><dd className="text-body font-medium">{dockTime(e.checkedIn, e.checkedInAt, e.zoneLabel)}</dd></div>
          <div><dt className="text-small text-muted-foreground">Delivery check-out</dt><dd className="text-body font-medium">{dockTime(e.checkedOut, e.checkedOutAt, e.zoneLabel)}</dd></div>
          <div><dt className="text-small text-muted-foreground">Minutes at the dock</dt><dd className="text-body font-medium">{e.minutesAtDock ?? "Unknown"}</dd></div>
          <div><dt className="text-small text-muted-foreground">Signed POD</dt><dd className="text-body font-medium">
            {e.pod === "present" ? (
              <a href={`/api/portal-runs/${view.run.id}/evidence/pod`} className="text-link underline">Download the POD (PDF)</a>
            ) : (
              "Not downloaded"
            )}
          </dd></div>
        </dl>
        <div className="flex flex-wrap items-center gap-2">{screening}</div>
        {e.screenVerdict === "flagged" ? (
          <InlineAlert tone="warning">The agent&apos;s answer looked like it carried instructions. Check the times against the screenshot before using them.</InlineAlert>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function PortalRunLive({ initial, timeZone }: { initial: RunView; timeZone: string }) {
  const [view, setView] = useState(initial);
  const [stale, setStale] = useState(false);
  const runId = initial.run.id;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal-runs/${runId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("read");
      const body = (await res.json()) as { run: RunView };
      setView(body.run);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [runId]);

  const live = LIVE.has(view.run.status);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  const r = view.run;
  const ended = endedWords(r.endedReason);
  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>
              Load {r.loadNumber} <span className="text-muted-foreground">({r.reference})</span>
            </CardTitle>
            <span className="flex flex-wrap items-center gap-2">
              {r.resumeAttempts > 0 ? <Badge tone="info">Resumed</Badge> : null}
              <StatusBadge status={r.stalled ? "unknown" : r.status} label={r.stalled ? "Stalled" : undefined} />
            </span>
          </div>
          <CardDescription>
            {targetName(r.model)} reading the broker&apos;s portal. {r.stepCount} steps, {formatSpend(r.costNanocents)}. Started{" "}
            {formatInstant(r.createdAt, timeZone)}.{r.resumed ? ` ${r.resumed}.` : ""}{ended ? ` ${ended}.` : ""}
          </CardDescription>
        </CardHeader>
        {stale ? (
          <CardBody>
            <InlineAlert tone="warning">Could not refresh this run. Showing the last update.</InlineAlert>
          </CardBody>
        ) : null}
      </Card>
      <ApprovalCard view={view} onDecided={refresh} />
      <EvidenceCard view={view} />
      <Card>
        <CardHeader>
          <CardTitle>Steps</CardTitle>
          <CardDescription>What the agent saw and did at each step. The cursor is drawn in each picture.</CardDescription>
        </CardHeader>
        <CardBody>
          {view.steps.length === 0 ? (
            <p className="text-body text-foreground-2">{live ? "Waiting for the first step." : "No steps were recorded."}</p>
          ) : (
            <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {view.steps.map((s, i) => (
                <li key={s.seq} className="grid content-start gap-2 rounded-md border border-border p-2">
                  {s.hasScreenshot ? (
                    <a href={shot(r.id, s.seq)} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={shot(r.id, s.seq)} alt={`Step ${s.seq}`} loading="lazy" className="w-full rounded border border-border" />
                    </a>
                  ) : null}
                  <p className="text-small font-medium">
                    Step {s.seq}
                    {s.kind === "opening" ? ": opened the portal" : s.kind === "answer" ? ": answered" : ""}
                    {!s.executed && s.kind === "action" ? " (not run)" : ""}
                    {s.stoppedEarly ? " (stopped early)" : ""}
                  </p>
                  {s.sentences.length > 0 ? (
                    <ul className="list-disc pl-5 text-small text-foreground-2">
                      {s.sentences.map((t, j) => (
                        <li key={j}>{withoutPlace(t)}</li>
                      ))}
                    </ul>
                  ) : null}
                  {placesOf(s.sentences).length > 0 ? (
                    <details className="text-caption text-muted-foreground">
                      <summary className="cursor-pointer text-link">Details</summary>
                      <ul className="list-disc pl-5">
                        {placesOf(s.sentences).map((t, j) => (
                          <li key={j}>{t}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <p className="text-caption text-muted-foreground">
                    {formatSpend(s.costNanocents)}
                    {seconds(view.steps, i) ? `, ${seconds(view.steps, i)}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
      <Card>
        <details>
          <summary className="cursor-pointer px-4 py-3 text-body font-medium">How this was worked out</summary>
          <CardBody className="grid gap-2">
            {view.evidence ? (
              <p className="text-small">
                Check against the portal&apos;s own record: {READBACK[view.evidence.readback]}.
              </p>
            ) : null}
            {view.calls.length === 0 ? (
              <p className="text-small text-foreground-2">No model calls yet.</p>
            ) : (
              <ul className="grid gap-1 text-small">
                {view.calls.map((c) => (
                  <li key={c.id}>
                    {targetName(c.target)}, {c.purpose.replace(/_/g, " ")}: {modelCallStatusLabel(c.status)}, {formatCallCost(c.costNanocents)}
                    {formatLatency(c.durationMs) ? `, ${formatLatency(c.durationMs)}` : ""}
                    {c.inputTokens !== null ? `, ${c.inputTokens} tokens in` : ""}
                    {c.outputTokens !== null ? `, ${c.outputTokens} out` : ""}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </details>
      </Card>
    </>
  );
}
