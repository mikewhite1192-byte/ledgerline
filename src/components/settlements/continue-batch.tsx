"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { settlementOutcome } from "@/lib/settlements/labels";

const whole = (v: unknown): number => (Number.isSafeInteger(v) ? (v as number) : 0);

// "Continue" on a batch still sending: one drain call (what fits in one request), then the page
// reads itself back.
export function ContinueBatch({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function run() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson(`/api/batches/${encodeURIComponent(batchId)}/drain`);
    if (reply.ok) {
      const d = reply.data;
      setNote(
        `${whole(d.confirmed)} confirmed, ${whole(d.failed)} failed, ${whole(d.unknown)} not confirmed yet, ` +
          `${whole(d.remaining)} still to send.`,
      );
    } else {
      setNote(settlementOutcome(reply.error));
    }
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="primary" pending={pending} onClick={() => void run()}>
        Continue
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
