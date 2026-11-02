"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { postJson } from "@/components/invoices/post-json";
import { PAUSE_MESSAGES, messageFor } from "./words";

// The one Pause or Resume button. Any staff member may pause; only an admin may resume
// (POST /api/autopilot/pause checks both). The button shows what a press would do, read from the
// page's own picture: after a press, and once a timed pause (the demo reset's) ends, the page reads
// itself again, so the status line and the button always agree.
export function PauseForm({
  paused,
  pausedUntil,
  canResume,
}: {
  paused: boolean;
  pausedUntil: string | null;
  canResume: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!paused || pausedUntil === null) return;
    const left = Date.parse(pausedUntil) - Date.now();
    if (!Number.isFinite(left)) return;
    // A second past the end, and never past the longest delay a timer holds.
    const timer = setTimeout(() => router.refresh(), Math.min(Math.max(left, 0) + 1_000, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [paused, pausedUntil, router]);

  async function press() {
    if (pending || refreshing) return;
    setPending(true);
    setProblem(null);
    const reply = await postJson("/api/autopilot/pause", { paused: !paused });
    if (reply.ok && reply.error === null && typeof reply.data.paused === "boolean") {
      startRefresh(() => router.refresh());
    } else {
      setProblem(messageFor(PAUSE_MESSAGES, reply.error));
    }
    setPending(false);
  }

  if (paused && !canResume) {
    return <p className="text-body text-foreground-2">Only an admin can resume the autopilot.</p>;
  }
  return (
    <div className="grid gap-3">
      <div>
        <Button type="button" variant={paused ? "primary" : "destructive"} pending={pending || refreshing} onClick={() => void press()}>
          {paused ? "Resume autopilot" : "Pause autopilot"}
        </Button>
      </div>
      {problem ? (
        <InlineAlert tone="destructive" className="w-full">
          {problem}
        </InlineAlert>
      ) : null}
    </div>
  );
}
