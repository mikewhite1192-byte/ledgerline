"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// "Run sweep now": makes the run id here (a double press or a retry replays the same run), opens
// the run and goes to its page, which carries it on. It never names a week: the start picks the
// newest open week after the pay week roll (D-090), so a week the roll opens on this press is the
// one swept, not the older week the page was showing. Fixed sentences only.

const NOTICE: Readonly<Record<string, string>> = {
  disabled: "The sweep is switched off right now.",
  no_open_period: "There is no open pay week to sweep.",
  not_configured: "The sweep is not set up for this carrier yet.",
  unauthenticated: "Your sign-in ended. Sign in again to run the sweep.",
};
const FALLBACK = "The sweep did not start. Try again.";

export function StartSweep({ hasOpenWeek, running }: { hasOpenWeek: boolean; running: boolean }) {
  const router = useRouter();
  const [runId, setRunId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");

  async function start() {
    const id = runId ?? crypto.randomUUID();
    setRunId(id);
    setPending(true);
    setNotice("");
    try {
      const res = await fetch("/api/sweeps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: id }),
      });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
      if (res.ok && typeof body.runId === "string") {
        router.push(`/sweep/${encodeURIComponent(body.runId)}`);
        return;
      }
      setNotice(NOTICE[body.error ?? ""] ?? FALLBACK);
      setRunId(null);
    } catch {
      // Unknown outcome: the same id is kept, so pressing again opens the same run.
      setNotice(FALLBACK);
    }
    setPending(false);
  }

  return (
    <div className="grid gap-2">
      <Button disabled={running || !hasOpenWeek} pending={pending} pendingLabel="Starting" onClick={() => void start()}>
        Run sweep now
      </Button>
      {notice ? (
        <p role="status" className="text-small text-foreground-2">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
