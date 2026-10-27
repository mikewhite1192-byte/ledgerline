"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { DataTable } from "@/components/app/data-table";
import { ProposalCard } from "@/components/app/proposal-card";
import { StatusBadge } from "@/components/app/status-badge";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { controlClass } from "@/components/ui/input";
import type { ProposalView } from "@/lib/agent/view";
import { formatInstant } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";
import {
  compareLine,
  DISMISS_CATEGORIES,
  DISMISS_WORDS,
  FUEL_LABELS,
  FUEL_PAGE_WORDS as W,
  FUEL_STATUS_TONE,
  FUEL_STATUS_WORDS,
  fuelHelp,
  gallonsText,
  noSuggestionLine,
  proposeLabel,
  runLine,
  shortDate,
  type DismissCategory,
} from "@/lib/fuel/help";
import type { FuelPage, FuelRowView } from "@/lib/fuel/view";
import { recordHref, type SourceRef } from "@/lib/records/href";
import { cn } from "@/lib/cn";

// The fuel checks page's working part (FUEL-ANOMALY design 4.6): one main button that checks the
// fill-ups, the rows, and one row's detail with its two actions. Every word is a fixed sentence
// from help.ts; a lost answer says the outcome is not known, never that nothing changed. After
// each action the page reads itself back from the server.

// Only these record kinds have a page of their own; any other source shows its name as text.
const LINKED: ReadonlySet<string> = new Set(["customers", "loads", "customer_payments", "invoices", "advances"]);
function hrefFor(ref: SourceRef): string {
  if (!LINKED.has(ref.table)) throw new RangeError("no page for this record");
  return recordHref(ref);
}

const APPROVE_NOTICE: Readonly<Record<string, string>> = {
  already_decided: "This correction was already decided.",
  expired: "This correction expired before anyone decided it. Check this week's fuel again.",
  role: "An admin must approve an amount this size.",
  auditor_required: "This waits for the auditor's check before anyone can approve it.",
  override_required: "Muse Wonder blocked this. Write why you approve it anyway, then confirm.",
  stale: "The records changed since this was drafted, so nothing was applied. Reject it, then check this week's fuel again.",
  needs_confirm: "Confirm the warning on the card first.",
  not_found: "That correction is not here.",
  not_executable: "Pay corrections are switched off, so nothing was applied.",
};
const APPROVE_FALLBACK = "The approval did not go through. Nothing changed.";
const APPROVE_UNKNOWN =
  "The answer did not come back, so this may or may not have been approved. Check the card's status before trying again.";
const REJECT_FAILED = "The rejection did not go through. Try again.";
const REJECT_UNKNOWN =
  "The answer did not come back, so this may or may not have been rejected. Check the card's status before trying again.";

function runNotice(error: string | null): string {
  switch (error) {
    case "busy":
      return W.busy;
    case "failed":
    case "unavailable":
      return W.failed;
    case "unknown":
      return W.notKnown;
    case "not_configured":
      return W.notSetUp;
    default:
      return W.refused;
  }
}

function proposeNotice(error: string | null): string {
  switch (error) {
    case "live_exists":
      return W.liveExists;
    case "changed":
    case "not_found":
    case "no_suggestion":
      return W.changed;
    case "no_open_period":
      return W.noOpenWeek;
    case "already_decided":
      return W.turnedDown;
    case "not_configured":
      return W.notSetUp;
    case "unknown":
    case "unavailable":
      return W.notKnown;
    default:
      return W.refused;
  }
}

function dismissNotice(error: string | null): string {
  switch (error) {
    case "changed":
    case "not_found":
      return W.changed;
    case "unknown":
    case "unavailable":
      return W.notKnown;
    default:
      return W.refused;
  }
}

function day(value: string): string {
  try {
    return shortDate(value);
  } catch {
    return value;
  }
}

function when(iso: string, zone: string): string {
  try {
    return formatInstant(iso, zone);
  } catch {
    return iso;
  }
}

function gallons(milli: number): string {
  try {
    return gallonsText(milli);
  } catch {
    return String(milli);
  }
}

function lastRunLine(page: FuelPage): string | null {
  const run = page.lastRun;
  if (!run) return null;
  if (run.status === "running") return W.running;
  if (run.status === "failed") return W.failed;
  return runLine(run.checked, page.needYou);
}

export function FuelChecks({ page, auditorOn, timezone }: { page: FuelPage; auditorOn: boolean; timezone: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState("");
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState<DismissCategory>("driver_explained");
  const panel = useRef<HTMLHeadingElement>(null);

  const open = page.rows.find((r) => r.id === openId) ?? null;
  useEffect(() => {
    if (!openId) return;
    panel.current?.focus();
    panel.current?.scrollIntoView?.({ block: "nearest" });
  }, [openId]);

  const note = (id: string, text: string) => setNotices((n) => ({ ...n, [id]: text }));

  async function check() {
    setBusy("run");
    setRunMessage("");
    const reply = await postJson("/api/fuel/runs");
    if (!reply.ok) setRunMessage(runNotice(reply.error));
    router.refresh();
    setBusy(null);
  }

  async function propose(row: FuelRowView) {
    setBusy(row.id);
    note(row.id, "");
    const reply = await postJson(`/api/fuel/findings/${encodeURIComponent(row.id)}/propose`);
    note(row.id, reply.ok ? W.sent : proposeNotice(reply.error));
    router.refresh();
    setBusy(null);
  }

  async function dismiss(row: FuelRowView) {
    setBusy(row.id);
    note(row.id, "");
    const reply = await postJson(`/api/fuel/findings/${encodeURIComponent(row.id)}/dismiss`, { category: reason });
    if (reply.ok) setDismissing(null);
    else note(row.id, dismissNotice(reply.error));
    router.refresh();
    setBusy(null);
  }

  async function approve(row: FuelRowView, p: ProposalView, overrideReason?: string) {
    setBusy(p.id);
    note(row.id, "");
    const confirmed = p.flagged || p.auditorVerdict !== "pass";
    const body = overrideReason
      ? { confirmed, overrideReason, auditedAt: p.auditorCheckedAt ?? undefined }
      : { confirmed };
    const reply = await postJson(`/api/proposals/${encodeURIComponent(p.id)}/approve`, body);
    if (!reply.ok) {
      note(row.id, reply.error === "unknown" || reply.error === "unavailable" ? APPROVE_UNKNOWN : (APPROVE_NOTICE[reply.error ?? ""] ?? APPROVE_FALLBACK));
    }
    router.refresh();
    setBusy(null);
  }

  async function reject(row: FuelRowView, id: string) {
    setBusy(id);
    note(row.id, "");
    const reply = await postJson(`/api/proposals/${encodeURIComponent(id)}/reject`, { category: "other" });
    if (!reply.ok) note(row.id, reply.error === "unknown" || reply.error === "unavailable" ? REJECT_UNKNOWN : REJECT_FAILED);
    router.refresh();
    setBusy(null);
  }

  const line = lastRunLine(page);
  const running = page.lastRun?.status === "running";

  return (
    <div className="grid gap-6">
      <Card className="grid gap-4 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5">
        <div className="grid gap-1" aria-live="polite">
          <p className="text-body text-foreground">{line ?? W.neverTitle}</p>
          {page.lastRun?.status === "done" && page.lastRun.finishedAt ? (
            <p className="text-small text-foreground-2">
              {W.lastChecked} {when(page.lastRun.finishedAt, timezone)}
            </p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Button disabled={running} pending={busy === "run"} pendingLabel={W.running} onClick={() => void check()}>
            {W.run}
          </Button>
          {runMessage ? (
            <p role="status" className="text-small text-foreground-2">
              {runMessage}
            </p>
          ) : null}
        </div>
      </Card>

      {open ? (
        <Card role="region" className="grid gap-4 px-4 py-4 sm:px-5" aria-labelledby="fuel-detail-title">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 id="fuel-detail-title" ref={panel} tabIndex={-1} className="text-h3 text-foreground outline-none">
              {FUEL_LABELS[open.check]}: {open.driverName}
            </h2>
            <div className="flex items-center gap-2">
              <StatusBadge status={FUEL_STATUS_TONE[open.status] ?? "draft"} label={FUEL_STATUS_WORDS[open.status] ?? open.status} />
              <Button variant="ghost" size="sm" onClick={() => setOpenId(null)}>
                {W.hideDetails}
              </Button>
            </div>
          </div>
          <p className="text-body text-foreground">{open.sentence}</p>
          <dl className="grid gap-x-6 gap-y-1 text-small sm:grid-cols-[auto_1fr]">
            <dt className="text-foreground-2">Fill-up</dt>
            <dd className="text-foreground">
              {open.purchaseRef}: {gallons(open.gallonsMilli)} gallons, {formatCents(open.amountCents)}
            </dd>
            {open.otherPurchaseRef ? (
              <>
                <dt className="text-foreground-2">Same fill-up again</dt>
                <dd className="text-foreground">{open.otherPurchaseRef}</dd>
              </>
            ) : null}
            {open.loadId && open.loadNumber ? (
              <>
                <dt className="text-foreground-2">Load</dt>
                <dd>
                  <Link href={recordHref({ table: "loads", id: open.loadId })} className="text-link underline-offset-4 hover:underline">
                    {open.loadNumber}
                  </Link>
                </dd>
              </>
            ) : null}
            {open.payItemRef ? (
              <>
                <dt className="text-foreground-2">Pay line</dt>
                <dd className="text-foreground">{open.payItemRef}</dd>
              </>
            ) : null}
            <dt className="text-foreground-2">Tank</dt>
            <dd className="text-foreground">{open.tankGallons} gallons</dd>
          </dl>

          {open.check === "fuel_duplicate" ? (
            <div className="grid gap-2">
              {open.photoIds.length === 2 ? (
                <div className="grid grid-cols-2 gap-3">
                  {open.photoIds.map((id, i) => (
                    <a key={id} href={`/documents/${encodeURIComponent(id)}`} className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/documents/${encodeURIComponent(id)}/file`}
                        alt={`Receipt photo ${i + 1}`}
                        loading="lazy"
                        className="h-auto w-full rounded-md border border-border"
                      />
                    </a>
                  ))}
                </div>
              ) : null}
              <p className="text-small text-foreground-2">{compareLine(open.compare)}</p>
            </div>
          ) : null}

          <RowActions
            row={open}
            busy={busy}
            dismissing={dismissing === open.id}
            reason={reason}
            onReason={setReason}
            onPropose={() => void propose(open)}
            onStartDismiss={() => setDismissing(open.id)}
            onCancelDismiss={() => setDismissing(null)}
            onDismiss={() => void dismiss(open)}
          />

          {open.proposal ? (
            <ProposalCard
              {...proposalCardFrom(open.proposal, { on: auditorOn, checking: false })}
              hrefFor={hrefFor}
              pending={busy === open.proposal.id}
              onApprove={(_id, why) => void approve(open, open.proposal as ProposalView, why)}
              onReject={(id) => void reject(open, id)}
            />
          ) : null}

          {notices[open.id] ? (
            <p role="status" className="text-small text-foreground">
              {notices[open.id]}
            </p>
          ) : null}
        </Card>
      ) : null}

      <DataTable
        caption="Fuel problems"
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={page.lastRun ? { title: W.emptyTitle, body: W.emptyBody } : { title: W.neverTitle, body: W.neverBody }}
        columns={[
          {
            key: "driver",
            header: "Driver",
            cell: (r) => (
              <span className="grid">
                <span>{r.driverName}</span>
                {r.truckUnit ? <span className="text-small text-foreground-2">Truck {r.truckUnit}</span> : null}
              </span>
            ),
          },
          { key: "date", header: "Date", cell: (r) => day(r.purchasedOn) },
          { key: "amount", header: "Amount", align: "right", cell: (r) => formatCents(r.amountCents) },
          {
            key: "problem",
            header: "Problem",
            cell: (r) => (
              <span title={fuelHelp(r.check, r.tankGallons, r.gallonsMilli)} className="cursor-help underline decoration-dotted underline-offset-4">
                {FUEL_LABELS[r.check]}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (r) => <StatusBadge status={FUEL_STATUS_TONE[r.status] ?? "draft"} label={FUEL_STATUS_WORDS[r.status] ?? r.status} />,
          },
          {
            key: "open",
            header: <span className="sr-only">Details</span>,
            align: "right",
            cell: (r) => (
              <Button
                variant={r.id === openId ? "secondary" : "outline"}
                size="sm"
                aria-expanded={r.id === openId}
                aria-label={`${r.id === openId ? W.hideDetails : W.details}: ${FUEL_LABELS[r.check]}, ${r.driverName}, ${day(r.purchasedOn)}`}
                onClick={() => {
                  setDismissing(null);
                  setOpenId(r.id === openId ? null : r.id);
                }}
              >
                {r.id === openId ? W.hideDetails : W.details}
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

function RowActions({
  row,
  busy,
  dismissing,
  reason,
  onReason,
  onPropose,
  onStartDismiss,
  onCancelDismiss,
  onDismiss,
}: {
  row: FuelRowView;
  busy: string | null;
  dismissing: boolean;
  reason: DismissCategory;
  onReason: (value: DismissCategory) => void;
  onPropose: () => void;
  onStartDismiss: () => void;
  onCancelDismiss: () => void;
  onDismiss: () => void;
}) {
  if (row.status === "dismissed") {
    const why = row.dismissCategory && Object.hasOwn(DISMISS_WORDS, row.dismissCategory)
      ? DISMISS_WORDS[row.dismissCategory as DismissCategory]
      : DISMISS_WORDS.other;
    return <p className="text-small text-foreground-2">Dismissed: {why}.</p>;
  }
  if (row.status === "cleared") return <p className="text-small text-foreground-2">{W.cleared}</p>;
  if (row.status !== "open") return null;

  const suggestion = row.suggestedCents !== null && row.suggestedCents !== 0 ? row.suggestedCents : null;
  const pending = busy === row.id;
  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {suggestion !== null ? (
          <Button pending={pending} pendingLabel="Sending" disabled={busy !== null && !pending} onClick={onPropose}>
            {proposeLabel(suggestion)}
          </Button>
        ) : null}
        {!dismissing ? (
          <Button variant="outline" disabled={busy !== null} onClick={onStartDismiss}>
            {W.dismiss}
          </Button>
        ) : null}
      </div>
      {suggestion === null ? (
        <p className="text-small text-foreground-2">
          {row.noSuggestion ? noSuggestionLine(row.noSuggestion, row.excessCents) : "No pay change suggested."}
        </p>
      ) : null}
      {dismissing ? (
        <div role="group" aria-label={W.dismissPick} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="grid gap-1 text-small text-foreground-2">
            {W.dismissPick}
            <select
              className={cn(controlClass, "h-9")}
              value={reason}
              onChange={(e) => onReason(e.target.value as DismissCategory)}
            >
              {DISMISS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {DISMISS_WORDS[c]}
                </option>
              ))}
            </select>
          </label>
          <Button variant="secondary" pending={pending} pendingLabel="Dismissing" onClick={onDismiss}>
            {W.dismissConfirm}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={onCancelDismiss}>
            {W.cancel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
