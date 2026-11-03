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
// itself again, so the status line and the button always agree. A Resume names the pause the page
// read (its row's revision), so a page showing an older pause never clears a newer one.

// While the server still reports a timed pause this browser's clock says has ended, the page reads
// itself again this often, at most this many times.
const RECHECK_MS = 5_000;
const MAX_RECHECKS = 12;

export function PauseForm({
  paused,
  revision,
  pausedUntil,
  canResume,
}: {
  paused: boolean;
  revision: string | null;
  pausedUntil: string | null;
  canResume: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  // How many times the page has read itself for this pause's end.
  const [checks, setChecks] = useState<{ until: string | null; n: number }>({ until: pausedUntil, n: 0 });
  const n = checks.until === pausedUntil ? checks.n : 0;

  useEffect(() => {
    if (!paused || pausedUntil === null || n > MAX_RECHECKS) return;
    const left = Date.parse(pausedUntil) - Date.now();
    if (!Number.isFinite(left)) return;
    // First a second past the end, and never past the longest delay a timer holds; then, while the
    // same pause comes back (the server's clock behind this one), every RECHECK_MS.
    const wait = n === 0 ? Math.min(Math.max(left, 0) + 1_000, 2_147_483_647) : RECHECK_MS;
    const timer = setTimeout(() => {
      router.refresh();
      setChecks({ until: pausedUntil, n: n + 1 });
    }, wait);
    return () => clearTimeout(timer);
  }, [paused, pausedUntil, n, router]);

  async function press() {
    if (pending || refreshing) return;
    setPending(true);
    setProblem(null);
    const reply = await postJson("/api/autopilot/pause", paused ? { paused: false, revision } : { paused: true });
    if (reply.ok && reply.error === null && typeof reply.data.paused === "boolean") {
      startRefresh(() => router.refresh());
    } else {
      setProblem(messageFor(PAUSE_MESSAGES, reply.error));
      // The switch changed since this page read it: read it again.
      if (reply.error === "changed") startRefresh(() => router.refresh());
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
