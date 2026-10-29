"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { writeOutcome } from "@/lib/briefs/words";
import { formatCents } from "@/lib/format/money";

// "Write this week's brief": one press opens the confirm, Confirm asks the agent once. A second
// press while the first runs does nothing; the outcome reads as a fixed sentence and the page reads
// itself back after.
export function WriteBrief({
  periodStart,
  weekText,
  again,
  maxCents,
}: {
  periodStart: string;
  // "Oct 19 to Oct 25, 2026"
  weekText: string;
  // A try before this one did not pass.
  again: boolean;
  maxCents: number;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function write() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson("/api/briefs/profit", { periodStart });
    setNote(writeOutcome(reply));
    setPending(false);
    setAsking(false);
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      {asking ? (
        <ConfirmPanel
          question={`Write the brief for ${weekText}?`}
          summary="The agent puts this week's figures into a few plain sentences. Every number it writes is checked against the figures on this page before you see it."
          next={`This asks the agent once and costs at most ${formatCents(maxCents)}. Nothing is sent to anyone.`}
          confirmLabel="Write the brief"
          pending={pending}
          pendingLabel="Writing"
          onConfirm={() => void write()}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <div>
          <Button type="button" onClick={() => setAsking(true)}>
            {again ? "Write the brief again" : "Write this week's brief"}
          </Button>
        </div>
      )}
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
