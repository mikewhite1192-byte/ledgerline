"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { outcomeLabel } from "@/lib/invoices/labels";
import { postJson } from "./post-json";

type Summary = { confirmed: number; failed: number; stillUnknown: number };

function isSummary(v: unknown): v is Summary {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return Number.isSafeInteger(s.confirmed) && Number.isSafeInteger(s.failed) && Number.isSafeInteger(s.stillUnknown);
}

// "Check QuickBooks" on a record page whose post nobody confirmed yet: reads this one record's
// unsettled post back from QuickBooks. It never sends anything new.
export function CheckButton({ url }: { url: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function check() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson(url);
    const s = reply.data.summary;
    if (reply.ok && isSummary(s)) {
      if (s.confirmed > 0) setNote("QuickBooks has it. Posted.");
      else if (s.failed > 0) setNote("QuickBooks did not confirm it at this amount. See the attempts below.");
      else setNote("QuickBooks has not shown it yet. Check again in a few minutes.");
    } else {
      setNote(outcomeLabel(reply.error));
    }
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" pending={pending} onClick={() => void check()}>
        <RefreshCw aria-hidden />
        Check QuickBooks
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
