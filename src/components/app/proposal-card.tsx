"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { recordLabel } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";
import { hrefOrNull, recordHref, type HrefFor, type SourceRef } from "@/lib/records/href";
import { Money } from "./money";
import { StatusBadge } from "./status-badge";

export type ProposalStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "executing"
  | "done"
  | "failed"
  | "unknown";

export type ProposalCardProps = {
  id: string;
  title: string;
  impact: { cents: number; direction: "in" | "out" | "none"; label?: string };
  reasons: { text: string; source?: SourceRef }[];
  sources?: SourceRef[];
  status: ProposalStatus;
  // The second question before a money action, e.g. "Pay $200.00 to Dana Whitfield?"
  confirmQuestion?: string;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  pending?: boolean;
  hrefFor?: HrefFor;
  // Opens with the confirm row showing (for review pages).
  initialConfirming?: boolean;
  className?: string;
};

// What the amount line says, by status. Only a done proposal may say that money moved.
const IMPACT_LABEL: Record<ProposalStatus, { in: string; out: string }> = {
  proposed: { out: "Would pay out", in: "Would come in" },
  approved: { out: "Would pay out", in: "Would come in" },
  executing: { out: "Would pay out", in: "Would come in" },
  done: { out: "Paid out", in: "Came in" },
  rejected: { out: "Not paid", in: "Not received" },
  failed: { out: "Not paid", in: "Not received" },
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
  unknown: "Sent, waiting on the read-back.",
};

// What the agent wants to do, what it costs, and why, with each reason one click from its record.
// A money action never happens on one tap: Approve asks once more, and only Confirm fires.
export function ProposalCard({
  id,
  title,
  impact,
  reasons,
  sources = [],
  status,
  confirmQuestion,
  onApprove,
  onReject,
  pending = false,
  hrefFor = recordHref,
  initialConfirming = false,
  className,
}: ProposalCardProps) {
  const [confirming, setConfirming] = useState(initialConfirming);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  const amount = formatCents(Math.abs(impact.cents));
  // With nothing paid or received, the buttons and the question leave the amount out.
  const noAmount = impact.cents === 0 || impact.direction === "none";
  const shown = impact.direction === "out" ? -Math.abs(impact.cents) : Math.abs(impact.cents);

  useEffect(() => {
    // Focus moves to Cancel (the safe choice) when the person opens the confirm row.
    if (confirming && opened.current) cancelRef.current?.focus();
  }, [confirming]);

  return (
    <Card className={cn("overflow-hidden", className)} aria-label={title} role="article">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
        <h3 className="min-w-0 flex-1 basis-56 text-h3 text-foreground">{title}</h3>
        <StatusBadge status={status} />
      </div>

      <div className="mx-4 mt-3 flex items-baseline justify-between gap-4 border-b border-border pb-3 sm:mx-5">
        <span className="text-small text-foreground-2">{impact.label ?? impactLabel(impact.direction, status)}</span>
        {impact.direction === "none" ? (
          // Money that changes place but not hands: the amount, unsigned and uncolored.
          <Money cents={Math.abs(impact.cents)} sign="never" tone="plain" className="text-h2 text-muted-foreground" />
        ) : (
          <Money cents={shown} sign={impact.direction === "in" ? "always" : "auto"} className="text-h2" />
        )}
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
                    {recordLabel(r.source)}
                  </Link>
                ) : r.source ? (
                  // A record the link rules do not know shows as its name, without a link.
                  <span className="ml-auto text-small text-foreground-2">{recordLabel(r.source)}</span>
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
                  {recordLabel(s)}
                </Link>
              ) : (
                <span key={`${s.table}:${s.id}`}>{recordLabel(s)}</span>
              );
            })}
          </p>
        ) : null}
      </div>

      {status === "proposed" ? (
        confirming ? (
          <div
            role="group"
            aria-label="Confirm approval"
            className="flex flex-col gap-3 border-t border-border bg-secondary px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          >
            <p className="text-body font-semibold text-foreground">
              {confirmQuestion ?? (noAmount ? "Approve this?" : `Approve ${amount}?`)}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button ref={cancelRef} variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button pending={pending} pendingLabel="Approving" onClick={() => onApprove?.(id)}>
                Confirm
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
            <Button variant="outline" disabled={pending} onClick={() => onReject?.(id)}>
              Reject
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                opened.current = true;
                setConfirming(true);
              }}
            >
              {noAmount ? "Approve" : `Approve ${amount}`}
            </Button>
          </div>
        )
      ) : (
        <p className="border-t border-border px-4 py-3 text-small text-foreground-2 sm:px-5">
          {STATUS_NOTE[status]}
        </p>
      )}
    </Card>
  );
}
