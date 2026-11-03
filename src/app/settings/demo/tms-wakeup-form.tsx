"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { postJson } from "@/components/invoices/post-json";

// A fixed message per category; nothing the server says is shown but the load's own reference.
export const TMS_WAKEUP_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "There is no dispatch load to wake yet. Sync dispatch first.",
  not_configured: "The dispatch webhook is not set up. Nothing was sent.",
  forbidden: "Only an admin of this carrier can fire a wake-up. Nothing was sent.",
  role: "Only an admin of this carrier can fire a wake-up. Nothing was sent.",
};

const FALLBACK = "The wake-up did not confirm. Try again in a moment.";

type Note = { tone: "success" | "destructive"; text: string } | null;

// "Fire a wake-up twice": the same dispatch wake-up sent twice for the newest mirrored load. The
// second is kept as the first's row, so the next sync reads the load once. It wakes nothing and
// moves no load and no money.
export function TmsWakeUpForm() {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function press() {
    if (pending) return;
    setPending(true);
    setNote(null);
    const reply = await postJson("/api/demo/tms-wakeup");
    if (reply.ok) {
      const d = reply.data;
      const ref = typeof d.reference === "string" && d.reference.length <= 64 ? d.reference : "the newest load";
      const one = d.waiting === 1 && d.second === "coalesced";
      setNote({
        tone: "success",
        text: one
          ? `Sent twice for ${ref}: one wake-up is waiting, so the next sync reads it once.`
          : `Sent twice for ${ref}. The next sync reads it.`,
      });
    } else {
      const text = (reply.error && Object.hasOwn(TMS_WAKEUP_MESSAGES, reply.error) ? TMS_WAKEUP_MESSAGES[reply.error] : null) ?? FALLBACK;
      setNote({ tone: "destructive", text });
    }
    setPending(false);
  }

  return (
    <div className="grid justify-items-start gap-3">
      <Button type="button" variant="secondary" pending={pending} pendingLabel="Sending" onClick={() => void press()}>
        Fire a wake-up twice
      </Button>
      {note ? (
        <InlineAlert tone={note.tone} className="w-full">
          {note.text}
        </InlineAlert>
      ) : null}
    </div>
  );
}
