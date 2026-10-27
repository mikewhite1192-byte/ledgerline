"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { outcomeLabel } from "@/lib/invoices/labels";
import { postJson } from "./post-json";

type Counts = { created: number; unchanged: number; retired: number; truncated: boolean };

function isCounts(v: unknown): v is Counts {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    Number.isSafeInteger(c.created) &&
    Number.isSafeInteger(c.unchanged) &&
    Number.isSafeInteger(c.retired) &&
    typeof c.truncated === "boolean"
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "Refresh": asks the rules engine for one card per invoiceable load. A second press while the
// first runs does nothing; pressing again later changes nothing that did not change.
export function RefreshButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");

  async function refresh() {
    if (pending) return;
    setPending(true);
    setNote("");
    const reply = await postJson("/api/invoices/propose");
    const counts = reply.data.counts;
    if (reply.ok && isCounts(counts)) {
      const parts = [plural(counts.created, "new card", "new cards"), plural(counts.unchanged, "unchanged", "unchanged")];
      if (counts.retired > 0) parts.push(plural(counts.retired, "expired", "expired"));
      setNote(`${parts.join(", ")}.${counts.truncated ? " More loads wait for the next refresh." : ""}`);
    } else {
      setNote(outcomeLabel(reply.error));
    }
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" pending={pending} onClick={() => void refresh()}>
        <RefreshCw aria-hidden />
        Refresh
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
      </p>
    </div>
  );
}
