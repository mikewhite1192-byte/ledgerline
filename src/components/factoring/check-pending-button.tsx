"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { CHECK_RESULT, checkResultSentence, factoringSentence } from "@/lib/factoring/words";

export const CHECK_PENDING_LABEL = "Check pending";

const count = (v: unknown): number => (Number.isSafeInteger(v) ? (v as number) : 0);

// "Check pending" on a factoring request whose invoices were sent but not confirmed yet: reads
// each one back from the factoring partner. It never sends anything new. A second press while the
// first runs does nothing. Fixed sentences only; whatever the answer, the page reads itself back.
export function CheckPendingButton({ url }: { url: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function check() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson(url);
    const s = reply.data.summary;
    if (reply.ok && s && typeof s === "object") {
      const summary = s as Record<string, unknown>;
      setNote(
        checkResultSentence({
          confirmed: count(summary.confirmed),
          failed: count(summary.failed),
          stillUnknown: count(summary.stillUnknown),
          errors: count(summary.errors),
          tooNew: count(reply.data.tooNew),
          stillWaiting: count(reply.data.stillWaiting),
        }),
      );
    } else if (reply.error === null || reply.error === "unknown") {
      setNote(CHECK_RESULT.lost);
    } else {
      setNote(factoringSentence(reply.error));
    }
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" pending={pending} pendingLabel="Checking" onClick={() => void check()}>
        <RefreshCw aria-hidden />
        {CHECK_PENDING_LABEL}
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
