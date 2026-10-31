"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { postJson } from "@/components/invoices/post-json";

// A fixed message per category; nothing the server or the dispatch system says is shown.
export const TMS_SYNC_MESSAGES: Readonly<Record<string, string>> = {
  disabled: "The dispatch sync is switched off. Nothing was read.",
  busy: "The desk is running right now. Try again in a minute.",
  not_configured: "This carrier has no dispatch connection yet. Nothing was read.",
  forbidden: "Only staff of this carrier can sync dispatch. Nothing was read.",
  unknown: "The sync did not confirm. Some loads may have been read; press again to finish.",
};

const FALLBACK = "Could not reach the dispatch system. Try again in a moment.";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

type Note = { tone: "success" | "destructive"; text: string } | null;

// "Sync dispatch now": one read of the dispatch system into the mirror. It moves no load and no
// money; the desk acts on what it finds, under its own switches.
export function TmsSyncForm() {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function press() {
    if (pending) return;
    setPending(true);
    setNote(null);
    const reply = await postJson("/api/demo/tms-sync");
    if (reply.ok) {
      const d = reply.data;
      const parts = [`${plural(count(d.read), "load")} read`, `${count(d.written)} updated`];
      if (count(d.gone) > 0) parts.push(`${count(d.gone)} gone from dispatch`);
      if (count(d.failed) > 0) parts.push(`${count(d.failed)} to retry`);
      const tail = typeof d.listFailed === "string" ? " The list did not answer; the next sync picks it up." : "";
      setNote({ tone: "success", text: `${parts.join(", ")}.${tail}` });
    } else {
      const text = (reply.error && Object.hasOwn(TMS_SYNC_MESSAGES, reply.error) ? TMS_SYNC_MESSAGES[reply.error] : null) ?? FALLBACK;
      setNote({ tone: "destructive", text });
    }
    setPending(false);
  }

  return (
    <div className="grid justify-items-start gap-3">
      <Button type="button" variant="secondary" pending={pending} pendingLabel="Syncing dispatch" onClick={() => void press()}>
        Sync dispatch now
      </Button>
      {note ? (
        <InlineAlert tone={note.tone} className="w-full">
          {note.text}
        </InlineAlert>
      ) : null}
    </div>
  );
}
