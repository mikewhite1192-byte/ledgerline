"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { Checklist } from "@/components/app/checklist";
import { PageHeader } from "@/components/app/page-header";
import { ProposalCard } from "@/components/app/proposal-card";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState, ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ProposalView } from "@/lib/agent/view";
import { formatPeriod } from "@/lib/format/dates";
import { codeToWords, recordNamer } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import type { SweepItemView, SweepPage } from "@/lib/sweep/view";
import { batchFor, type HeldBatch } from "./batch-id";
import { WeekChecks } from "./week-checks";

// A sweep run's page (design 3.10): the run's checklist of phases, ticked as it moves (agents-101
// 3.1), the run's counts, how the week was checked a second time when
// the run did that (week-checks.tsx), then Clean fixes (each card keeps its own
// Approve and Reject, plus one "Approve all clean" bar), Needs a look, Needs a person, and the
// fixed, declined and expired ones folded away. While the run is running the page carries it on
// one slice at a time. Every word is a fixed label; the only model text is an explanation or a
// second check's note that passed the figures check.

const ADVANCE_LIMIT = 60;
const BUSY_WAIT_MS = 3_000;

const NOT_DRAFTED: Readonly<Record<string, string>> = {
  mismatch: "The drafted amount did not match the figure from your pay rules, so it was set aside.",
  blocked_live: "Not drafted: a card waiting for approval already covers this driver.",
  audit_pending: "Waiting for the second check.",
  over_cap: "Not drafted: the sweep's model budget for this run ran out.",
  expired_earlier: "Not drafted: an earlier fix for this expired before anyone decided it.",
  found: "Not drafted yet.",
};

const APPROVE_NOTICE: Readonly<Record<string, string>> = {
  already_decided: "This fix was already decided.",
  expired: "This fix expired before anyone decided it. The sweep does not draft it again; add it by hand if it is still owed.",
  role: "An admin must approve an amount this size.",
  auditor_required: "This waits for the second check before anyone can approve it.",
  override_required: "The second check did not pass this. Write why you approve it anyway, then confirm.",
  stale: "The records changed since this was drafted, so it was not applied. Reject it if it still waits, then run the sweep again.",
  needs_confirm: "Confirm the warning on the card first.",
  not_found: "That fix is not here.",
  not_executable: "Pay corrections are switched off, so this fix was not applied. Nothing changed.",
};
// The card statuses listed under Needs a look: still waiting, or approved and not finished.
const LOOK_STATUSES: ReadonlySet<string> = new Set(["proposed", "approved", "executing", "unknown"]);

// A definite refusal (a 4xx answer) says nothing changed. A lost answer (no response, or a 5xx
// after the work may have started) is unknown: it never says nothing changed.
const APPROVE_FALLBACK = "The approval did not go through. Nothing changed.";
const REJECT_FAILED = "The rejection did not go through. Try again.";
const APPROVE_UNKNOWN =
  "The answer did not come back, so this may or may not have been approved. Check the card's status before trying again.";
const REJECT_UNKNOWN =
  "The answer did not come back, so this may or may not have been rejected. Check the card's status before trying again.";
const BATCH_UNKNOWN =
  "The answer did not come back, so some fixes may have been approved. Check each card's status before trying again; a repeat of the same list never approves twice.";
// The proposal statuses an approval can end on without finishing: approved, but not done.
const NOT_FINISHED: ReadonlySet<string> = new Set(["approved", "executing", "unknown"]);

const lostAnswer = (res: Response) => res.status >= 500;

// One line of an approve-all answer that did not finish: the gate's reason in the same words a
// single approval uses; a fix left approved but not finished, or one with no reason, is unknown.
function batchNotice(category: string | null): string {
  if (category !== null && APPROVE_NOTICE[category]) return APPROVE_NOTICE[category];
  if (category === null || NOT_FINISHED.has(category)) return APPROVE_UNKNOWN;
  return APPROVE_FALLBACK;
}

// The refused lines of an approve-all answer, keeping only well-formed ones.
function refusedLines(value: unknown): { proposalId: string; category: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r: unknown) => {
    if (!r || typeof r !== "object") return [];
    const { proposalId, category } = r as Record<string, unknown>;
    if (typeof proposalId !== "string") return [];
    return [{ proposalId, category: typeof category === "string" ? category : null }];
  });
}

function notDrafted(item: SweepItemView): string {
  if (item.status === "refused") return `Not drafted: ${codeToWords(item.refusalCategory ?? "unknown").toLowerCase()}.`;
  return NOT_DRAFTED[item.status] ?? "Needs a look.";
}

async function errorOf(res: Response): Promise<{ error: string; body: Record<string, unknown> }> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return { error: typeof body.error === "string" ? body.error : "unknown", body };
  } catch {
    return { error: "unknown", body: {} };
  }
}

function banner(page: SweepPage): string {
  const week = page.run.periodStart;
  const { found, fixes_drafted: drafted } = page.counts;
  let when = week;
  try {
    when = formatPeriod(page.run.periodStart, page.run.periodEnd);
  } catch {
    // shown as stored
  }
  if (page.run.status === "running") return `Checking the week of ${when}. Found ${found} so far.`;
  if (page.run.status === "failed") return `The sweep of ${when} stopped before it finished.`;
  const fixes = `${drafted} ${drafted === 1 ? "fix" : "fixes"}`;
  const problems = `${found} ${found === 1 ? "problem" : "problems"}`;
  return page.run.trigger === "schedule"
    ? `Before anyone logged in, LedgerLine found ${problems} in the week of ${when} and drafted ${fixes}.`
    : `LedgerLine checked the week of ${when}, found ${problems} and drafted ${fixes}.`;
}

export function SweepRun({
  initial,
  auditorOn,
  timezone,
}: {
  initial: SweepPage;
  auditorOn: boolean;
  // The carrier's time zone, for times shown on a card (an override's time).
  timezone?: string;
}) {
  const [page, setPage] = useState(initial);
  const [readFailed, setReadFailed] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [confirmAll, setConfirmAll] = useState(false);
  const [allNotice, setAllNotice] = useState("");
  const [batch, setBatch] = useState<HeldBatch | null>(null);
  const alive = useRef(true);
  const runId = page.run.id;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/sweeps/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("read");
      const next = (await res.json()) as SweepPage;
      if (alive.current) {
        setPage(next);
        setReadFailed(false);
      }
    } catch {
      if (alive.current) setReadFailed(true);
    }
  }, [runId]);

  // Carry a running run on, one slice per request, a bounded number of times per page view.
  const running = page.run.status === "running";
  useEffect(() => {
    if (!running) return;
    let stop = false;
    let calls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function step() {
      if (stop) return;
      if (calls >= ADVANCE_LIMIT) {
        setStalled(true);
        return;
      }
      calls += 1;
      let wait = 0;
      try {
        const res = await fetch(`/api/sweeps/${encodeURIComponent(runId)}/advance`, { method: "POST" });
        if (!res.ok) wait = BUSY_WAIT_MS;
      } catch {
        wait = BUSY_WAIT_MS;
      }
      await refresh();
      if (!stop) timer = setTimeout(() => void step(), wait);
    }
    void step();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, runId, refresh]);

  async function approve(p: ProposalView, overrideReason?: string) {
    setBusy(p.id);
    setNotices((n) => ({ ...n, [p.id]: "" }));
    const confirmed = p.flagged || p.auditorVerdict !== "pass";
    const body = overrideReason
      ? { confirmed, overrideReason, auditedAt: p.auditorCheckedAt ?? undefined }
      : { confirmed };
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(p.id)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (lostAnswer(res)) {
        setNotices((n) => ({ ...n, [p.id]: APPROVE_UNKNOWN }));
      } else if (!res.ok) {
        const { error } = await errorOf(res);
        setNotices((n) => ({ ...n, [p.id]: APPROVE_NOTICE[error] ?? APPROVE_FALLBACK }));
      }
    } catch {
      setNotices((n) => ({ ...n, [p.id]: APPROVE_UNKNOWN }));
    }
    await refresh();
    if (alive.current) setBusy(null);
  }

  async function reject(id: string) {
    setBusy(id);
    setNotices((n) => ({ ...n, [id]: "" }));
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: "other" }),
      });
      if (lostAnswer(res)) setNotices((n) => ({ ...n, [id]: REJECT_UNKNOWN }));
      else if (!res.ok) setNotices((n) => ({ ...n, [id]: REJECT_FAILED }));
    } catch {
      setNotices((n) => ({ ...n, [id]: REJECT_UNKNOWN }));
    }
    await refresh();
    if (alive.current) setBusy(null);
  }

  // One batch id per confirmed list and total (batch-id.ts): a retry of the same confirm replays
  // it, a changed list or total gets a new id.
  async function approveAll() {
    const ids = page.clean.proposalIds;
    if (ids.length === 0) return;
    const held = batchFor(batch, ids, page.clean.totalCents, () => crypto.randomUUID());
    setBatch(held);
    setBusy("all");
    setAllNotice("");
    let next: HeldBatch | null = null;
    try {
      const res = await fetch(`/api/sweeps/${encodeURIComponent(runId)}/approve-clean`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId: held.id, proposalIds: ids, totalCents: page.clean.totalCents }),
      });
      if (res.ok) {
        const r = (await res.json()) as { done: number; refused: unknown };
        const lines = refusedLines(r.refused);
        next = null;
        if (lines.length > 0) {
          setNotices((n) => ({ ...n, ...Object.fromEntries(lines.map((l) => [l.proposalId, batchNotice(l.category)])) }));
        }
        setAllNotice(
          lines.length > 0
            ? `Approved ${r.done}. ${lines.length} did not go through; each card says why.`
            : `Approved ${r.done} ${r.done === 1 ? "fix" : "fixes"}. Each lands on the driver's next pay run.`,
        );
      } else if (lostAnswer(res)) {
        // The server stopped part way: some fixes may be approved. Keep the same batch id, so
        // trying the same list again replays rather than repeats.
        setAllNotice(BATCH_UNKNOWN);
        next = held;
      } else {
        const { error, body } = await errorOf(res);
        if (error === "changed") {
          const n = Array.isArray(body.clean) ? body.clean.length : 0;
          const total = typeof body.totalCents === "number" ? formatCents(body.totalCents) : "an unknown total";
          setAllNotice(`The clean list changed: it now has ${n} ${n === 1 ? "fix" : "fixes"}, ${total} total. Check them and approve again. Nothing was approved.`);
        } else if (error === "role") {
          setAllNotice("An admin must approve a batch this size. Nothing was approved.");
        } else if (error === "batch_reused" || error === "batch_taken") {
          // This id can never be ours again: the next try takes a new one.
          setAllNotice("The approval did not go through. Nothing was approved.");
        } else {
          setAllNotice("The approval did not go through. Nothing was approved.");
          next = held;
        }
      }
    } catch {
      // Unknown outcome: keep the same batch id, so trying again replays rather than repeats.
      setAllNotice(BATCH_UNKNOWN);
      next = held;
    }
    setBatch(next);
    setConfirmAll(false);
    await refresh();
    if (alive.current) setBusy(null);
  }

  const proposalOf = (item: SweepItemView) => (item.proposalId ? page.proposals[item.proposalId] : undefined);
  const fixes = page.items.filter((i) => i.kind === "fix");
  const seen = new Set<string>();
  const once = (i: SweepItemView) => {
    if (!i.proposalId) return true;
    if (seen.has(i.proposalId)) return false;
    seen.add(i.proposalId);
    return true;
  };
  const clean = fixes.filter((i) => i.clean && proposalOf(i)?.status === "proposed").filter(once);
  const earlier = (i: SweepItemView) =>
    i.status === "fixed_earlier" || i.status === "declined_earlier" || i.status === "expired_earlier";
  // A fix approved or running, or one whose outcome is not known, is not a no: it stays here under
  // its own status, never under Declined.
  const look = fixes
    .filter((i) => !i.clean && !earlier(i) && LOOK_STATUSES.has(proposalOf(i)?.status ?? "proposed"))
    .filter(once);
  const fixed = fixes.filter((i) => i.status === "fixed_earlier" || proposalOf(i)?.status === "done").filter(once);
  // Expired with nobody deciding is not a person's no, so it is never listed as declined.
  const expired = fixes
    .filter((i) => i.status === "expired_earlier" || proposalOf(i)?.status === "expired")
    .filter(once);
  // Declined is a person's no (rejected) or a run that failed, nothing else.
  const declined = fixes
    .filter((i) => {
      const s = proposalOf(i)?.status;
      if (i.status === "expired_earlier" || s === "expired") return false;
      return i.status === "declined_earlier" || s === "rejected" || s === "failed";
    })
    .filter(once);
  const people = page.items.filter((i) => i.kind === "needs_person");

  const card = (item: SweepItemView) => {
    const p = proposalOf(item);
    if (!p) {
      return (
        <Card key={item.id} className="px-4 py-3 sm:px-5">
          <p className="text-body text-foreground">
            {codeToWords(item.check)} for {item.driverCode ?? "a driver"}
            {item.expectedCents !== null ? `, ${formatCents(item.expectedCents)}` : ""}
          </p>
          <p className="text-small text-foreground-2">{notDrafted(item)}</p>
        </Card>
      );
    }
    return (
      <div key={item.id} className="grid gap-1.5">
        <ProposalCard
          {...proposalCardFrom(p, { on: auditorOn, checking: item.status === "audit_pending", timezone })}
          pending={busy === p.id || busy === "all"}
          onApprove={(_id, reason) => void approve(p, reason)}
          onReject={(id) => void reject(id)}
        />
        {item.explanation ? (
          <p className="px-1 text-small text-foreground-2">
            <span className="font-semibold">Muse Spark:</span> {item.explanation}
          </p>
        ) : null}
        {item.status !== "drafted" && p.status === "proposed" ? (
          <p className="px-1 text-small text-foreground-2">{notDrafted(item)}</p>
        ) : null}
        {notices[p.id] ? (
          <p role="status" className="px-1 text-small text-destructive">
            {notices[p.id]}
          </p>
        ) : null}
      </div>
    );
  };

  const total = formatCents(page.clean.totalCents);
  const n = page.clean.proposalIds.length;

  return (
    <div className="mx-auto grid w-full max-w-[880px] gap-6 px-4 py-6 md:px-6 md:py-8">
      <PageHeader
        title="Pay sweep"
        description={banner(page)}
        actions={<StatusBadge status={page.run.status === "running" ? "executing" : page.run.status} label={codeToWords(page.run.status)} />}
      />
      {page.run.checklist ? <Checklist list={page.run.checklist} /> : null}
      <section aria-label="Counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Found" value={page.counts.found} />
        <StatCard label="Fixes drafted" value={page.counts.fixes_drafted} />
        <StatCard label="Clean" value={page.counts.clean} />
        <StatCard label="Need a person" value={page.counts.needs_person} />
      </section>
      {page.run.truncatedReason ? (
        <p role="note" className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-small text-foreground">
          {page.run.truncatedReason === "cap"
            ? "The sweep stopped early: its model budget for this run ran out. Run it again to carry on."
            : "The sweep took the first problems only. Run it again after these are handled."}
        </p>
      ) : null}
      {page.fanout ? <WeekChecks tree={page.fanout} runId={runId} running={running} /> : null}
      {readFailed ? <ErrorState category="unreadable" title="Could not read the sweep" /> : null}
      {stalled ? (
        <p role="status" className="text-small text-foreground-2">
          Still running. Reload the page to carry it on.
        </p>
      ) : null}

      <section aria-labelledby="clean-fixes" className="grid gap-3">
        <h3 id="clean-fixes" className="text-h3 text-foreground">
          Clean fixes
        </h3>
        {clean.length === 0 ? (
          <p className="text-body text-foreground-2">{running ? "Drafting..." : "No clean fixes waiting."}</p>
        ) : (
          clean.map(card)
        )}
        {n > 0 ? (
          <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-card px-4 py-3 shadow-float sm:mx-0 sm:rounded-lg sm:border">
            {confirmAll ? (
              <div role="group" aria-label="Confirm approve all" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-body font-semibold text-foreground">
                  Approve {n} {n === 1 ? "fix" : "fixes"} for {total} in all?
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="outline" disabled={busy === "all"} onClick={() => setConfirmAll(false)}>
                    Cancel
                  </Button>
                  <Button pending={busy === "all"} pendingLabel="Approving" onClick={() => void approveAll()}>
                    Confirm
                  </Button>
                </div>
              </div>
            ) : (
              <Button className="w-full sm:w-auto" disabled={busy !== null} onClick={() => setConfirmAll(true)}>
                Approve {n} clean {n === 1 ? "fix" : "fixes"}, {total} total
              </Button>
            )}
          </div>
        ) : null}
        {allNotice ? (
          <p role="status" className="text-small text-foreground">
            {allNotice}
          </p>
        ) : null}
      </section>

      {look.length > 0 ? (
        <section aria-labelledby="needs-look" className="grid gap-3">
          <h3 id="needs-look" className="text-h3 text-foreground">
            Needs a look
          </h3>
          {look.map(card)}
        </section>
      ) : null}

      <section aria-labelledby="needs-person" className="grid gap-3">
        <h3 id="needs-person" className="text-h3 text-foreground">
          Needs a person
        </h3>
        {people.length === 0 ? (
          <p className="text-body text-foreground-2">Nothing waiting on a person.</p>
        ) : (
          <ul className="grid gap-2">
            {people.map((i) => (
              <li key={i.id}>
                <Card className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                  <span className="text-body text-foreground">{i.note ?? "Needs a look."}</span>
                  <RecordLinks item={i} />
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {fixed.length > 0 ? (
        <details className="rounded-lg border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-body font-semibold text-foreground">Fixed ({fixed.length})</summary>
          <div className="mt-3 grid gap-3">{fixed.map(card)}</div>
        </details>
      ) : null}
      {declined.length > 0 ? (
        <details className="rounded-lg border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-body font-semibold text-foreground">
            Declined ({declined.length})
          </summary>
          <div className="mt-3 grid gap-3">{declined.map(card)}</div>
        </details>
      ) : null}
      {expired.length > 0 ? (
        <details className="rounded-lg border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-body font-semibold text-foreground">
            Expired undecided ({expired.length})
          </summary>
          <p className="mt-2 text-small text-foreground-2">
            Each of these expired before anyone decided it. The sweep does not draft them again; add one
            by hand if it is still owed.
          </p>
          <div className="mt-3 grid gap-3">{expired.map(card)}</div>
        </details>
      ) : null}

      {page.items.length === 0 && !running ? (
        <EmptyState title="Nothing to fix this week" body="The sweep found no problems in this week's pay." />
      ) : null}
      <Link href="/sweep" className="w-fit text-small text-link underline-offset-4 hover:underline">
        All sweeps
      </Link>
    </div>
  );
}

// The records behind a needs-a-person line, each one click away.
function RecordLinks({ item }: { item: SweepItemView }) {
  const refs = item.sourceRefs.slice(0, 3);
  const name = recordNamer(refs);
  return (
    <span className="flex flex-wrap gap-x-3 text-small">
      {refs.map((r) => {
        const href = hrefOrNull(recordHref, r);
        return href ? (
          <Link key={`${r.table}:${r.id}`} href={href} className="text-link underline-offset-4 hover:underline">
            {name(r)}
          </Link>
        ) : (
          <span key={`${r.table}:${r.id}`} className="text-foreground-2">
            {name(r)}
          </span>
        );
      })}
    </span>
  );
}
