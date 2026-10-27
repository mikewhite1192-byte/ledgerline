"use client";

import { CreditCard } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { OVERRIDE_REASON, overrideReasonOf } from "@/lib/agent/auditor/words";
import { cn } from "@/lib/cn";
import { recordNamer } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";
import { hrefOrNull, recordHref, type HrefFor, type SourceRef } from "@/lib/records/href";
import { Money } from "./money";
import { StatusBadge } from "./status-badge";
import { Term } from "./term";

export type ProposalStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "executing"
  | "done"
  | "failed"
  | "expired"
  | "unknown";

// The auditor's check, shown above the buttons (design 4.2). Every word is fixed text: text is the
// plain sentence per concern, never the model's words; override is a person's reason, shown with
// who (a role label) and when.
export type ProposalAudit = {
  state: "checking" | "pass" | "concerns" | "block" | "unknown" | "off" | "budget";
  text?: string;
  override?: { reason: string; byLabel: string; at: string };
};

export type ProposalCardProps = {
  id: string;
  title: string;
  impact: { cents: number; direction: "in" | "out" | "none"; label?: string };
  // label, when set, names the record's link in place of its kind and id ("Driver BR-D07's paystub").
  reasons: { text: string; source?: SourceRef; label?: string }[];
  sources?: (SourceRef & { label?: string })[];
  status: ProposalStatus;
  // Where the money would land, one small line under the amount, e.g. "To fuel card ···· 4417".
  // testMode adds " · Test mode" to it.
  destination?: { label: string; testMode: boolean };
  // One more small line under the amount, e.g. "Load L-1042: $120.00 of $300.00 cap left after this."
  detail?: string;
  // The second question before a money action, e.g. "Pay $200.00 to Dana Whitfield?"
  confirmQuestion?: string;
  // A warning shown above the buttons, e.g. why this proposal needs a second look.
  flagNote?: string;
  audit?: ProposalAudit;
  // overrideReason is set only when the person approves over a block, with their trimmed reason.
  // Resume calls it too, with no reason.
  onApprove?: (id: string, overrideReason?: string) => void;
  // An approved proposal whose run stopped before it finished: the card offers Resume, which asks
  // the same approve request again (the server treats it as a resume and pays at most once). Only
  // honored while the status is approved; Reject is never offered on an approved card.
  canResume?: boolean;
  onReject?: (id: string) => void;
  pending?: boolean;
  hrefFor?: HrefFor;
  // Opens with the confirm row showing (for review pages).
  initialConfirming?: boolean;
  // Words a kind uses in place of the defaults: a pay rule change is saved, not approved, and its
  // secondary control is a plain "Not now" link.
  wording?: ProposalWording;
  // Set when this person cannot approve it (an amount above their role): the main button shows
  // this text, disabled, and no confirm row opens.
  approveBlockedLabel?: string;
  // A block cannot be approved over with a reason (a pay rule change is asked again instead): a
  // blocked card offers only the secondary control.
  noOverride?: boolean;
  // Plain lines in place of the auditor's badges, by state (a pay rule change says
  // "double-checked"). A state with no line keeps its badge.
  auditWords?: Partial<Record<ProposalAudit["state"], string>>;
  // One line above the buttons, on every status.
  footnote?: string;
  // The line under a decided card, in place of the default for its status, with an optional link.
  statusNotes?: Partial<Record<Exclude<ProposalStatus, "proposed">, StatusNote>>;
  className?: string;
};

export type ProposalWording = { approve: string; approving: string; question: string; reject: string };

export type StatusNote = { text: string; link?: { href: string; label: string } };

// What the amount line says, by status. Only a done proposal may say that money moved.
const IMPACT_LABEL: Record<ProposalStatus, { in: string; out: string }> = {
  proposed: { out: "Would pay out", in: "Would come in" },
  approved: { out: "Would pay out", in: "Would come in" },
  executing: { out: "Would pay out", in: "Would come in" },
  done: { out: "Paid out", in: "Came in" },
  rejected: { out: "Not paid", in: "Not received" },
  failed: { out: "Not paid", in: "Not received" },
  expired: { out: "Not paid", in: "Not received" },
  unknown: { out: "Pay out, not confirmed", in: "Coming in, not confirmed" },
};

function impactLabel(direction: ProposalCardProps["impact"]["direction"], status: ProposalStatus): string {
  return direction === "none" ? "No money moves" : IMPACT_LABEL[status][direction];
}

const STATUS_NOTE: Record<Exclude<ProposalStatus, "proposed">, string> = {
  approved: "Approved and queued to run.",
  executing: "Running now.",
  done: "Done and recorded.",
  rejected: "Rejected. Nothing changed.",
  failed: "Failed. Check the record before trying again.",
  expired: "Expired before anyone approved it. Nothing changed.",
  unknown: "Sent. Waiting for it to be confirmed; it is checked again on its own, and nothing is paid twice.",
};

const RESUME_NOTE = "Approved, but it stopped before it finished. Resume picks it up where it stopped.";

// The second check's line, in a clerk's words. The model that ran it is named on the trace
// ("How this was worked out"), not here.
const AUDIT_BADGE: Record<Exclude<ProposalAudit["state"], "checking">, { tone: BadgeTone; label: string }> = {
  pass: { tone: "success", label: "Second check passed" },
  concerns: { tone: "warning", label: "Second check has concerns" },
  block: { tone: "destructive", label: "Second check did not pass" },
  unknown: { tone: "neutral", label: "Second check could not run" },
  budget: { tone: "neutral", label: "Second check skipped: demo budget reached" },
  off: { tone: "neutral", label: "Second check is off" },
};

const BUDGET_TEXT = "The second check could not run on this request. Your data is unchanged.";

function AuditLine({
  audit,
  words,
}: {
  audit: ProposalAudit;
  words?: Partial<Record<ProposalAudit["state"], string>>;
}) {
  const line = words?.[audit.state];
  if (line !== undefined) {
    // The kind's own plain line for this state, then the same concern text and override as below.
    return (
      <div role={audit.state === "checking" ? "status" : undefined} className="mx-4 mb-3 grid gap-1.5 sm:mx-5">
        <p
          className={cn(
            "text-small",
            audit.state === "block" ? "font-semibold text-destructive" : audit.state === "pass" ? "text-success" : "text-foreground-2",
          )}
        >
          {line}
        </p>
        {audit.text && audit.state !== "pass" && audit.state !== "checking" ? (
          <p className="text-small text-foreground">{audit.text}</p>
        ) : null}
        {audit.override ? (
          <p className="text-small text-foreground-2">
            Overridden by {audit.override.byLabel} on {audit.override.at}: {audit.override.reason}
          </p>
        ) : null}
      </div>
    );
  }
  if (audit.state === "checking") {
    return (
      <div role="status" className="mx-4 mb-3 grid gap-1.5 sm:mx-5">
        <span className="text-small text-foreground-2">Running the second check...</span>
        <Skeleton className="w-48 max-w-full" />
      </div>
    );
  }
  const badge = AUDIT_BADGE[audit.state];
  const text = audit.state === "budget" ? BUDGET_TEXT : audit.text;
  return (
    <div className="mx-4 mb-3 grid gap-1.5 sm:mx-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>
          <Term id="second-check">{badge.label}</Term>
        </Badge>
      </div>
      {text && audit.state !== "pass" ? <p className="text-small text-foreground">{text}</p> : null}
      {audit.override ? (
        <p className="text-small text-foreground-2">
          Overridden by {audit.override.byLabel} on {audit.override.at}: {audit.override.reason}
        </p>
      ) : null}
    </div>
  );
}

// What the agent wants to do, what it costs, and why, with each reason one click from its record.
// A money action never happens on one tap: Approve asks once more, and only Confirm fires. A
// proposal the auditor blocked has no Approve: the person writes why, then confirms the override.
export function ProposalCard({
  id,
  title,
  impact,
  reasons,
  sources = [],
  status,
  destination,
  detail,
  confirmQuestion,
  flagNote,
  audit,
  onApprove,
  onReject,
  canResume = false,
  pending = false,
  hrefFor = recordHref,
  initialConfirming = false,
  wording,
  approveBlockedLabel,
  auditWords,
  footnote,
  statusNotes,
  noOverride = false,
  className,
}: ProposalCardProps) {
  const [confirming, setConfirming] = useState(initialConfirming);
  const [reason, setReason] = useState("");
  const [overriding, setOverriding] = useState(false);
  const blocked = audit?.state === "block" && !audit.override;
  const validReason = overrideReasonOf(reason);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  const cancelled = useRef(false);
  const amount = formatCents(Math.abs(impact.cents));
  // One name per record across the reasons and "Also read", so two loads never both read "Load".
  const sourceName = recordNamer([...reasons.flatMap((r) => (r.source ? [r.source] : [])), ...sources]);
  // With nothing paid or received, the buttons and the question leave the amount out.
  const noAmount = impact.cents === 0 || impact.direction === "none";
  const shown = impact.direction === "out" ? -Math.abs(impact.cents) : Math.abs(impact.cents);

  useEffect(() => {
    // Focus moves to Cancel (the safe choice) when the person opens the confirm row.
    if (confirming && opened.current) cancelRef.current?.focus();
    // Cancel closes the row it sits in, so focus goes back to Approve instead of the page.
    if (!confirming && cancelled.current) {
      cancelled.current = false;
      approveRef.current?.focus();
    }
  }, [confirming]);

  return (
    <Card className={cn("overflow-hidden", className)} aria-label={title} role="article">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
        <h3 className="min-w-0 flex-1 basis-56 text-h3 text-foreground">{title}</h3>
        <StatusBadge status={status} />
      </div>

      <div className="mx-4 mt-3 border-b border-border pb-3 sm:mx-5">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-small text-foreground-2">{impact.label ?? impactLabel(impact.direction, status)}</span>
          {impact.direction === "none" ? (
            // Money that changes place but not hands: the amount, unsigned and uncolored.
            <Money cents={Math.abs(impact.cents)} sign="never" tone="plain" className="text-h2 text-muted-foreground" />
          ) : (
            <Money cents={shown} sign={impact.direction === "in" ? "always" : "auto"} className="text-h2" />
          )}
        </div>
        {destination ? (
          <p className="mt-1 flex items-center gap-1.5 text-small text-muted-foreground">
            <CreditCard className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              {destination.label}
              {destination.testMode ? " · Test mode" : ""}
            </span>
          </p>
        ) : null}
        {detail ? <p className="mt-1 text-small text-muted-foreground">{detail}</p> : null}
      </div>

      <div className="px-4 pt-3 pb-4 sm:px-5">
        <p className="text-small font-semibold text-foreground-2">Why</p>
        <ul className="mt-1.5 grid gap-1.5">
          {reasons.map((r, i) => {
            const href = r.source ? hrefOrNull(hrefFor, r.source) : null;
            return (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-body">
                <span className="text-foreground">{r.text}</span>
                {r.source && href ? (
                  <Link href={href} className="ml-auto text-small text-link underline-offset-4 hover:underline">
                    {r.label ?? sourceName(r.source)}
                  </Link>
                ) : r.source ? (
                  // A record the link rules do not know shows as its name, without a link.
                  <span className="ml-auto text-small text-foreground-2">{r.label ?? sourceName(r.source)}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {sources.length > 0 ? (
          <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-small text-muted-foreground">
            <span>Also read:</span>
            {sources.map((s) => {
              const href = hrefOrNull(hrefFor, s);
              return href ? (
                <Link key={`${s.table}:${s.id}`} href={href} className="text-link underline-offset-4 hover:underline">
                  {s.label ?? sourceName(s)}
                </Link>
              ) : (
                <span key={`${s.table}:${s.id}`}>{s.label ?? sourceName(s)}</span>
              );
            })}
          </p>
        ) : null}
      </div>

      {audit ? <AuditLine audit={audit} words={auditWords} /> : null}

      {flagNote ? (
        <p role="note" className="mx-4 mb-3 rounded-md border border-warning bg-warning-soft px-3 py-2 text-small text-foreground sm:mx-5">
          {flagNote}
        </p>
      ) : null}

      {footnote ? <p className="mx-4 mb-3 text-small text-foreground-2 sm:mx-5">{footnote}</p> : null}

      {status === "proposed" ? (
        confirming ? (
          <div
            role="group"
            aria-label="Confirm approval"
            className="flex flex-col gap-3 border-t border-border bg-secondary px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          >
            <p className="text-body font-semibold text-foreground">
              {overriding
                ? "Approve even though the second check did not pass?"
                : (confirmQuestion ?? wording?.question ?? (noAmount ? "Approve this?" : `Approve ${amount}?`))}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                ref={cancelRef}
                variant="outline"
                disabled={pending}
                onClick={() => {
                  cancelled.current = true;
                  setConfirming(false);
                  setOverriding(false);
                }}
              >
                Cancel
              </Button>
              <Button
                pending={pending}
                pendingLabel={wording?.approving ?? "Approving"}
                disabled={overriding ? validReason === null : blocked}
                onClick={() =>
                  overriding && validReason !== null ? onApprove?.(id, validReason) : onApprove?.(id)
                }
              >
                Confirm
              </Button>
            </div>
          </div>
        ) : blocked && noOverride ? (
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
            <RejectControl wording={wording} pending={pending} onClick={() => onReject?.(id)} />
          </div>
        ) : blocked ? (
          <div className="grid gap-2 border-t border-border px-4 py-3 sm:px-5">
            <Label htmlFor={`override-${id}`}>
              Why approve it anyway? ({OVERRIDE_REASON.min} to {OVERRIDE_REASON.max} characters)
            </Label>
            <Textarea
              id={`override-${id}`}
              value={reason}
              disabled={pending}
              maxLength={OVERRIDE_REASON.max * 2}
              aria-describedby={`override-count-${id}`}
              className="w-full"
              onChange={(e) => setReason(e.target.value)}
            />
            <p id={`override-count-${id}`} className="text-small text-muted-foreground">
              {reason.trim().length} of {OVERRIDE_REASON.max}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <RejectControl wording={wording} pending={pending} onClick={() => onReject?.(id)} />
              <Button
                ref={approveRef}
                disabled={pending || validReason === null}
                onClick={() => {
                  opened.current = true;
                  setOverriding(true);
                  setConfirming(true);
                }}
              >
                Override and approve
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-5">
            <RejectControl wording={wording} pending={pending} onClick={() => onReject?.(id)} />
            <Button
              ref={approveRef}
              disabled={pending || approveBlockedLabel !== undefined}
              onClick={() => {
                if (approveBlockedLabel !== undefined) return;
                opened.current = true;
                setConfirming(true);
              }}
            >
              {approveBlockedLabel ?? wording?.approve ?? (noAmount ? "Approve" : `Approve ${amount}`)}
            </Button>
          </div>
        )
      ) : canResume && status === "approved" ? (
        // The approval already stands (it passed its confirm when it was given), so Resume is one
        // click: it carries on the same approval and never asks for a new decision.
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-small text-foreground-2">{RESUME_NOTE}</p>
          <Button pending={pending} pendingLabel="Resuming" disabled={pending} onClick={() => onApprove?.(id)}>
            Resume
          </Button>
        </div>
      ) : (
        <DecidedNote note={statusNotes?.[status] ?? { text: STATUS_NOTE[status] }} />
      )}
    </Card>
  );
}

// The secondary control: today's outlined Reject, or the kind's own words as a plain link.
function RejectControl({
  wording,
  pending,
  onClick,
}: {
  wording?: ProposalWording;
  pending: boolean;
  onClick: () => void;
}) {
  return wording ? (
    <Button variant="link" disabled={pending} onClick={onClick} className="self-center sm:mr-2">
      {wording.reject}
    </Button>
  ) : (
    <Button variant="outline" disabled={pending} onClick={onClick}>
      Reject
    </Button>
  );
}

// A decided card's line. A link's label, where the sentence says it, becomes the link in place;
// otherwise the link follows the sentence.
function DecidedNote({ note }: { note: StatusNote }) {
  const at = note.link ? note.text.lastIndexOf(note.link.label) : -1;
  const link = note.link ? (
    <Link href={note.link.href} className="text-link underline-offset-4 hover:underline">
      {note.link.label}
    </Link>
  ) : null;
  return (
    <p className="border-t border-border px-4 py-3 text-small text-foreground-2 sm:px-5">
      {note.link && at >= 0 ? (
        <>
          {note.text.slice(0, at)}
          {link}
          {note.text.slice(at + note.link.label.length)}
        </>
      ) : (
        <>
          {note.text}
          {link ? <> {link}</> : null}
        </>
      )}
    </p>
  );
}
