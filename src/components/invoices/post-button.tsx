"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { outcomeLabel } from "@/lib/invoices/labels";
import { postJson } from "./post-json";

// What a post that went through reads as, by the ledger row's state.
const STATE_NOTE: Readonly<Record<string, string>> = {
  confirmed: "Posted to QuickBooks.",
  sent: "Sent to QuickBooks, waiting on the read-back.",
  reserved: "Sent to QuickBooks, waiting on the read-back.",
  unknown: "Sent to QuickBooks, waiting on the read-back.",
  // A failure may be a refusal or a record already there at another amount, so it claims neither.
  failed: "QuickBooks did not confirm it at this amount. Check QuickBooks before trying again.",
};

// "Post to QuickBooks" on a record page. The server's ledger key makes a second click a replay of
// the first attempt; this button only keeps a click from going out twice while one is running.
export function PostButton({ url, label = "Post to QuickBooks" }: { url: string; label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function post() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson(url);
    const state = typeof reply.data.state === "string" ? reply.data.state : reply.data.posting;
    if (reply.ok && typeof state === "string") {
      setNote(Object.hasOwn(STATE_NOTE, state) ? STATE_NOTE[state] : outcomeLabel(state));
    } else {
      setNote(outcomeLabel(reply.error));
    }
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="primary" pending={pending} onClick={() => void post()}>
        {label}
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
