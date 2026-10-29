"use client";

import { Banknote } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { CHECK_NOT_CONFIRMED, CHECK_NOTICE } from "@/lib/cash/labels";

export const CHECK_LABEL = "Check Friday's cash";

// The Cash page's one main button: the rules engine works out Friday's position from the
// carrier's records, saves it and makes or refreshes the cards. It approves, pays and sends
// nothing. A second press while the first runs does nothing. Fixed sentences only; whatever the
// answer, the page reads itself back.
export function CheckCashButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function check() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson("/api/cash/check");
    if (!reply.ok) {
      const category = reply.error ?? "unknown";
      setNote(Object.hasOwn(CHECK_NOTICE, category) ? CHECK_NOTICE[category] : CHECK_NOT_CONFIRMED);
    }
    setPending(false);
    router.refresh();
  }

  return (
    <div className="grid justify-items-start gap-2 sm:justify-items-end">
      <Button type="button" pending={pending} pendingLabel="Checking" onClick={() => void check()}>
        <Banknote aria-hidden />
        {CHECK_LABEL}
      </Button>
      {note ? (
        <p role="status" className="max-w-[40ch] text-small text-foreground-2">
          {note}
        </p>
      ) : null}
    </div>
  );
}
