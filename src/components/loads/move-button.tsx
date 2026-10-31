"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/components/invoices/post-json";

// What a press reads as, by the server's category. Never the server's own words.
const NOTE: Readonly<Record<string, string>> = {
  moved: "Done. The load's history has the move.",
  already: "The load was already there.",
  wrong_status: "The load is not at the step before this one. Reload the page.",
  date_out_of_window: "The load's pickup date has not come yet.",
  no_driver: "The load has no driver yet, so it cannot be delivered.",
  forbidden: "Only staff can move a load.",
  not_found: "That load is not on this carrier's books.",
  unknown: "Not confirmed yet. Reload the page to see the load.",
};

const FALLBACK = "Could not move the load. Try again.";

// "Mark picked up" or "Mark delivered" on a load's record page: one step, recorded as a person's
// press. No money moves. The server's status guard makes a second press a no-op; this button only
// keeps a click from going out twice while one is running.
export function MoveButton({ loadId, to }: { loadId: string; to: "in_transit" | "delivered" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function press() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson(`/api/loads/${loadId}/move`, { to });
    if (reply.ok) setNote(reply.data.changed === true ? NOTE.moved : NOTE.already);
    else setNote((reply.error && Object.hasOwn(NOTE, reply.error) ? NOTE[reply.error] : null) ?? FALLBACK);
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="secondary" pending={pending} onClick={() => void press()}>
        {to === "in_transit" ? "Mark picked up" : "Mark delivered"}
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
