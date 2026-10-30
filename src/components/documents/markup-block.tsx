"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Term } from "@/components/app/term";
import { canTryMarkup, markupBadge } from "@/components/documents/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import type { MarkupView } from "@/lib/documents/types";

// The document page's "Marked copy" block: a sample picture of the photo with the line in
// question circled and what the records say written beside it. Only a copy that read back the
// same numbers is ever kept and shown; the numbers on the page come from the records, never from
// the copy. Every sentence is fixed; a refusal shows its category's sentence, never upstream text.

const MESSAGES: Record<string, string> = {
  in_progress: "A marked copy is being made. Reload the page in a minute.",
  already_checked: "This document already has a checked copy. Reload the page to see it.",
  attempt_limit: "No tries left for this document. The comparison table shows the difference.",
  limit: "This carrier made its marked copies for today. Try again tomorrow.",
  budget: "Waiting for budget. Nothing changed.",
  not_image: "Marking works on photos. This document is a PDF; the comparison table shows the difference.",
  agrees: "Nothing to mark: this document agrees with your records.",
  no_anchor_line: "Nothing to circle: the value is not on a line the read could quote.",
  not_matched: "Nothing to mark: this document is not matched to a record.",
  not_read: "This document has not been read yet.",
  not_found: "That document is not here.",
  disabled: "Marked copies are not switched on.",
  unauthenticated: "Your session ended. Sign in again.",
  forbidden: "This login cannot mark documents for this carrier.",
  unavailable: "Could not start the marked copy. Nothing changed. Try again in a moment.",
  network: "Could not reach LedgerLine. Check the connection and try again.",
};

const BLOCKED: Record<string, string> = {
  not_image: MESSAGES.not_image,
  agrees: MESSAGES.agrees,
  no_anchor_line: `${MESSAGES.no_anchor_line} The comparison table shows the difference.`,
  not_matched: MESSAGES.not_matched,
};

function triesLeft(n: number): string {
  return `${n} ${n === 1 ? "try" : "tries"} left`;
}

// What the last try left, in one sentence, for a document without a kept copy.
function lastTry(markup: MarkupView): string | null {
  if (markup.status === "mismatch") {
    return "The marked copy did not read back the same numbers, so it was not kept. Nothing changed.";
  }
  if (markup.status === "marking" && markup.stalled) return "The last try did not finish. Nothing changed.";
  if (markup.status !== "unavailable") return null;
  switch (markup.category) {
    case "budget":
      return "Waiting for budget. Nothing changed.";
    case "timeout":
      return "The image model did not answer in time. Nothing changed.";
    case "too_large":
      return "The marked copy came back too large to keep. Nothing changed.";
    default:
      return "Could not make the marked copy this time. Nothing changed.";
  }
}

function MarkButton({ documentId, label }: { documentId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/markup`, { method: "POST" });
      const data: unknown = await res.json().catch(() => null);
      const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const category = typeof record.error === "string" ? record.error : "unavailable";
      if (!res.ok) setError(Object.hasOwn(MESSAGES, category) ? MESSAGES[category] : MESSAGES.unavailable);
      // The row may have changed either way (a kept copy, a try that was not kept, or a wait for
      // budget), so the page reads it again.
      router.refresh();
    } catch {
      setError(MESSAGES.network);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid justify-items-start gap-3">
      <Button onClick={onClick} pending={pending} pendingLabel="Marking the photo">
        {label}
      </Button>
      {error ? (
        <InlineAlert tone="destructive" className="w-full">
          {error}
        </InlineAlert>
      ) : null}
    </div>
  );
}

export function MarkupBlock({
  documentId,
  filename,
  markup,
  checkedOn,
}: {
  documentId: string;
  filename: string;
  markup: MarkupView;
  // The checked copy's date as the carrier reads it ("Oct 27, 2026"), or null.
  checkedOn: string | null;
}) {
  if (markup.eligibility === null || markup.eligibility === "not_read") return null;
  const badge = markupBadge(markup);
  const heading = (
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          <Term id="marked-copy">Marked copy</Term>
        </CardTitle>
        {markup.eligibility === "eligible" || markup.status === "checked" ? (
          <Badge tone={badge.tone}>{badge.label}</Badge>
        ) : null}
      </div>
    </CardHeader>
  );

  if (markup.status === "checked") {
    const src = `/api/documents/${documentId}/markup/file`;
    return (
      <Card className="overflow-hidden">
        {heading}
        <CardBody className="grid gap-3">
          {/* The file route answers with no-store for one carrier's login, so the plain element is
              used on purpose (the image optimizer would cache private bytes). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={`${filename} with the line in question circled and what your records say written beside it`}
            className="h-auto w-full rounded-md border border-border"
          />
          <p className="text-small text-foreground-2">
            {checkedOn ? `Checked ${checkedOn} against the record. ` : "Checked against the record. "}A sample
            picture: the numbers on this page come from your records, never from this copy.
          </p>
          <div>
            <a href={src} className="text-small font-medium text-link underline-offset-4 hover:underline">
              Save image
            </a>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (markup.eligibility !== "eligible") {
    return (
      <Card>
        {heading}
        <CardBody>
          <CardDescription>{BLOCKED[markup.eligibility] ?? MESSAGES.not_matched}</CardDescription>
        </CardBody>
      </Card>
    );
  }

  if (markup.status === "marking" && !markup.stalled) {
    return (
      <Card>
        {heading}
        <CardBody>
          <InlineAlert tone="info" title="Marking the photo">
            The image model is drawing the copy and a second model is reading it back. Reload the page in a
            minute.
          </InlineAlert>
        </CardBody>
      </Card>
    );
  }

  const last = lastTry(markup);
  return (
    <Card>
      {heading}
      <CardBody className="grid gap-3">
        {last ? <p className="text-body text-foreground">{last}</p> : null}
        {canTryMarkup(markup) ? (
          <>
            <MarkButton
              documentId={documentId}
              label={markup.status === "none" ? "Mark it on the photo" : `Try again (${triesLeft(markup.attemptsLeft)})`}
            />
            <p className="text-small text-foreground-2">
              The image model circles the line and writes what your records say. A{" "}
              <Term id="second-check">second check</Term> reads the copy back; it is kept only if every number
              still matches.
            </p>
          </>
        ) : (
          <p className="text-small text-foreground-2">
            No tries left for this document. The comparison table shows the difference.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
