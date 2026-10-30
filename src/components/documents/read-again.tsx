"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { STAFF_ONLY_NOTE } from "@/components/app/staff-only";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { READ_ATTEMPTS_MAX } from "@/lib/documents/types";

// Read again, for a document whose first read never finished. The server takes the read only
// when it has been pending for two minutes, and only once, so a double click starts one read. A
// read whose outcome is not known leaves the document pending: the button says so and stays.

const MESSAGES: Record<string, string> = {
  in_progress: "The last read started less than two minutes ago. Wait a few minutes, then reload the page.",
  not_finished: "Could not finish reading. Try Read again in a few minutes.",
  attempt_limit: `This document was tried ${READ_ATTEMPTS_MAX} times. Upload a clearer copy.`,
  already_read: "This document has been read. Reload the page to see it.",
  not_found: "That document is not here.",
  disabled: "Document reading is not switched on.",
  unauthenticated: "Your session ended. Sign in again.",
  forbidden: "This login cannot read documents for this carrier.",
  judge: STAFF_ONLY_NOTE,
  unavailable: "Could not start the read. Try again in a moment.",
  network: "Could not reach LedgerLine. Check the connection and try again.",
};

export function ReadAgainButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/read`, { method: "POST" });
      const data: unknown = await res.json().catch(() => null);
      const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const category = typeof record.error === "string" ? record.error : "unavailable";
      const doc = record.document && typeof record.document === "object" ? (record.document as Record<string, unknown>) : null;
      if (res.ok && doc?.readStatus === "pending") {
        // Nothing was saved this time; the page would still say reading, so the button says why.
        const attempts = Number(doc.readAttempts);
        setError(attempts >= READ_ATTEMPTS_MAX ? MESSAGES.attempt_limit : MESSAGES.not_finished);
      } else if (res.ok) router.refresh();
      else setError(Object.hasOwn(MESSAGES, category) ? MESSAGES[category] : MESSAGES.unavailable);
    } catch {
      setError(MESSAGES.network);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid justify-items-start gap-3">
      <Button variant="outline" onClick={onClick} pending={pending} pendingLabel="Reading the document">
        Read again
      </Button>
      {error ? (
        <InlineAlert tone="destructive" className="w-full">
          {error}
        </InlineAlert>
      ) : null}
    </div>
  );
}
