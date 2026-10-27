import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInstant, formatLocalDate } from "@/lib/format/dates";
import { accountingLine } from "@/lib/invoices/labels";
import type { InvoiceReviewView, ReviewReasonView } from "@/lib/invoices/review-read";
import { recordHref } from "@/lib/records/href";
import { CheckButton } from "./check-button";
import { RecordLink } from "./cells";
import { PostButton } from "./post-button";
import { MarkReviewedForm, MarkSentForm } from "./review-actions";

// The Review card at the top of an invoice: the engine's status, every reason as a sentence with
// the records behind it, where it stands in accounting, and the one next step for its status.
// Nothing here sends an invoice; "Mark as sent" records a send a person made elsewhere.

const LIVE = new Set(["open", "partially_paid"]);

function ReasonLinks({ reason, view }: { reason: ReviewReasonView; view: InvoiceReviewView }) {
  const links: ReactNode[] = [];
  const loadReasons = ["engine_total_differs", "rate_confirmation_differs", "no_delivery_document"];
  if (loadReasons.includes(reason.reason) && view.loadId) {
    links.push(
      <RecordLink key="load" table="loads" id={view.loadId}>
        See the load
      </RecordLink>,
    );
  }
  if (reason.reason === "same_amount_recent") {
    for (const d of view.duplicates) {
      links.push(
        <RecordLink key={d.id} table="invoices" id={d.id}>
          {d.invoiceNumber || "The other invoice"}
        </RecordLink>,
      );
    }
  }
  if (reason.reason === "posting_failed" || reason.reason === "posting_unknown") {
    links.push(
      <a key="ledger" href="#posting-attempts" className="text-link underline-offset-4 hover:underline">
        See the attempts
      </a>,
    );
  }
  if (links.length === 0) return null;
  return <span className="flex flex-wrap gap-x-3 gap-y-1 text-small">{links}</span>;
}

export function ReviewCard({
  view,
  roles,
  today,
  timezone,
}: {
  view: InvoiceReviewView;
  roles: ReadonlyMap<string, string>;
  today: string;
  timezone: string;
}) {
  const id = encodeURIComponent(view.invoiceId);
  const live = LIVE.has(view.invoiceStatus);
  const status = view.review.status;
  const who = (memberId: string | null) => (memberId === null ? null : (roles.get(memberId) ?? null));
  const accounting = accountingLine({
    posted: view.posted,
    emailStatus: view.emailStatus,
    sentOn: view.sentOn === null ? null : formatLocalDate(view.sentOn),
    sentBy: who(view.sentByMembershipId),
  });
  const reviewedBy = who(view.reviewedByMembershipId);
  const reasons = view.reasons.map((r) => r.reason);
  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle>Review</CardTitle>
        <StatusBadge status={status} label={view.statusLabel} />
      </CardHeader>
      <CardBody className="grid gap-4">
        {!live ? (
          <p className="text-body text-foreground-2">Paid and void invoices are settled; they are not reviewed.</p>
        ) : view.reasons.length > 0 ? (
          <ul className="grid gap-3">
            {view.reasons.map((r) => (
              <li key={r.reason} className="grid gap-1">
                <span className="text-body text-foreground">{r.sentence}</span>
                <ReasonLinks reason={r} view={view} />
              </li>
            ))}
          </ul>
        ) : null}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <div className="grid min-w-0 gap-0.5">
            <dt className="text-small text-foreground-2">Accounting</dt>
            <dd className="min-w-0 text-body text-foreground">{accounting}</dd>
          </div>
          <div className="grid min-w-0 gap-0.5">
            <dt className="text-small text-foreground-2">Reviewed</dt>
            <dd className="min-w-0 text-body text-foreground">
              {view.reviewedAt === null
                ? "Not yet"
                : `${formatInstant(view.reviewedAt, timezone)}${reviewedBy ? ` by ${reviewedBy}` : ""}`}
              {view.reviewNote ? <span className="block text-small text-foreground-2">{view.reviewNote}</span> : null}
            </dd>
          </div>
        </dl>
        {live ? (
          <div className="grid gap-4">
            {status === "sync_error" && reasons.includes("posting_failed") ? (
              <PostButton url={`/api/invoices/${id}/post`} label="Retry post" />
            ) : null}
            {status === "sync_error" && reasons.includes("posting_unknown") ? (
              <CheckButton url={`/api/invoices/${id}/reconcile`} label="Check pending" />
            ) : null}
            {status === "rate_mismatch" && view.loadId ? (
              <div>
                <Link href={recordHref({ table: "loads", id: view.loadId })} className={buttonVariants({ variant: "outline" })}>
                  Open the load
                </Link>
              </div>
            ) : null}
            {/* A duplicate warning clears only with a person's review, so the button shows on any
                live invoice nobody has reviewed yet. */}
            {view.reviewedAt === null ? <MarkReviewedForm url={`/api/invoices/${id}/review`} /> : null}
            {status === "ready_to_send" && view.posted && view.sentOn === null ? (
              <MarkSentForm url={`/api/invoices/${id}/mark-sent`} issuedOn={view.issuedOn} today={today} />
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
