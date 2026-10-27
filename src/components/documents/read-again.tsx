"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";

// Read again, for a document whose first read never finished. The server takes the read only
// when it has been pending for two minutes, and only once, so a double click starts one read.

const MESSAGES: Record<string, string> = {
  in_progress: "A read is already running. Give it a minute, then reload the page.",
  already_read: "This document has been read. Reload the page to see it.",
  not_found: "That document is not here.",
  disabled: "Document reading is not switched on.",
  unauthenticated: "Your session ended. Sign in again.",
  forbidden: "This login cannot read documents for this carrier.",
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
      const category =
        data && typeof data === "object" && typeof (data as Record<string, unknown>).error === "string"
          ? String((data as Record<string, unknown>).error)
          : "unavailable";
      if (res.ok) router.refresh();
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
