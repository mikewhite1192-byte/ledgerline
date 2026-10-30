"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { reviewOutcome } from "@/lib/briefs/quarter-words";
import { formatCents } from "@/lib/format/money";

// "Write the quarter review": one press opens the confirm, Confirm asks the agent once. A second
// press while the first runs does nothing; while it runs the page says it takes up to 30 seconds,
// the outcome reads as a fixed sentence, and the page reads itself back after.
export function WriteReview({ again, maxCents }: { again: boolean; maxCents: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function write() {
    if (pending) return;
    setPending(true);
    setNote("Reading the quarter. This takes up to 30 seconds.");
    const reply = await postJson("/api/briefs/quarter", {});
    setNote(reviewOutcome(reply));
    setPending(false);
    setAsking(false);
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      {asking ? (
        <ConfirmPanel
          question="Write the quarter review?"
          summary="The agent reads the quarter's figures on this page and writes what went well, the recurring problems, the money recovered and three things to change. Every number it writes is checked against these figures before you see it."
          next={`This asks the agent once and costs at most ${formatCents(maxCents)}. Nothing is sent to anyone.`}
          confirmLabel="Write the review"
          pending={pending}
          pendingLabel="Writing"
          onConfirm={() => void write()}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <div>
          <Button type="button" onClick={() => setAsking(true)}>
            {again ? "Write the quarter review again" : "Write the quarter review"}
          </Button>
        </div>
      )}
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
