"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useViewerRole } from "@/components/app/viewer-role";

// Carrying a running pay check on from the browser, one slice per request, a bounded number of
// times per page view: the pay check's own page (sweep-run.tsx) and Home (CarryOn below) share it.
// A demo visitor (the judge role) only reads a run: carrying it on is for the carrier's staff, so
// neither ever asks (the route would refuse a judge anyway).

export const ADVANCE_LIMIT = 60;
export const BUSY_WAIT_MS = 3_000;

// afterStep reads the run again after each slice; the caller's running flag, set from what it
// read, ends the loop, and afterStep answering false ends it at once (before the flag's render).
// onLimit says the loop stopped at ADVANCE_LIMIT with the run still running.
// Both are the caller's stable callbacks (useCallback), so the loop is not restarted each render.
export function useCarryOn({
  runId,
  running,
  off,
  afterStep,
  onLimit,
}: {
  runId: string;
  running: boolean;
  off: boolean;
  afterStep: () => Promise<boolean | void>;
  onLimit?: () => void;
}): void {
  useEffect(() => {
    if (!running || off) return;
    let stop = false;
    let calls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function step() {
      if (stop) return;
      if (calls >= ADVANCE_LIMIT) {
        onLimit?.();
        return;
      }
      calls += 1;
      let wait = 0;
      try {
        const res = await fetch(`/api/sweeps/${encodeURIComponent(runId)}/advance`, { method: "POST" });
        if (!res.ok) wait = BUSY_WAIT_MS;
      } catch {
        wait = BUSY_WAIT_MS;
      }
      const more = await afterStep();
      if (!stop && more !== false) timer = setTimeout(() => void step(), wait);
    }
    void step();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, off, runId, afterStep, onLimit]);
}

// Home's carry-on for the newest run while it is running (a visit's copy starts one as it opens,
// src/lib/visit-copy/story.ts): it renders nothing, carries the run on, and once a read says the
// run is no longer running, refreshes Home once so "What I did today" shows how it came out. A read
// that fails or does not say is unknown, and the run is carried on as running.
export function CarryOn({ runId }: { runId: string }) {
  const judge = useViewerRole() === "judge";
  const router = useRouter();
  const [running, setRunning] = useState(true);
  const refreshed = useRef(false);
  const afterStep = useCallback(async () => {
    try {
      const res = await fetch(`/api/sweeps/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (!res.ok) return true;
      const page = (await res.json()) as { run?: { status?: unknown } };
      const status = page?.run?.status;
      if (typeof status !== "string" || status.length === 0 || status === "running") return true;
      setRunning(false);
      if (!refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
      return false;
    } catch {
      // unknown: carried on as running
      return true;
    }
  }, [runId, router]);
  useCarryOn({ runId, running, off: judge, afterStep });
  return null;
}
