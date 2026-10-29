"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/components/invoices/post-json";

// "Check cards": opens a check (a check already running is carried on, never a second one), then
// asks for the next slice until the check is done, and reads the page back. A check still running
// when the page opens is carried on the same way. Fixed sentences only.

const NOTICE: Readonly<Record<string, string>> = {
  disabled: "The card check is switched off right now.",
  unauthenticated: "Your sign-in ended. Sign in again to check cards.",
  forbidden: "You cannot check cards for this carrier.",
  not_found: "That check is not here any more. Press Check cards again.",
};
// A lost or unreadable reply: the check may still be running on the server.
const UNKNOWN = "The check did not answer. It may still be running; refresh the page in a minute to see.";
const LONG = "The check is still running. Refresh the page in a minute to see the result.";

export const MAX_SLICES = 30;
const PAUSE_MS = 1_500;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function CheckCards({ runningId }: { runningId: string | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const busy = useRef(false);

  // One slice at a time, bounded; the page is read back once the check is done or failed.
  const follow = useCallback(
    async (runId: string) => {
      for (let i = 0; i < MAX_SLICES && alive.current; i += 1) {
        const out = await postJson(`/api/cards/check/${encodeURIComponent(runId)}`);
        if (!alive.current) return;
        if (!out.ok) {
          setNotice(out.error && Object.hasOwn(NOTICE, out.error) ? NOTICE[out.error] : UNKNOWN);
          return;
        }
        if (out.data.status !== "running") {
          router.refresh();
          return;
        }
        await wait(PAUSE_MS);
      }
      if (alive.current) setNotice(LONG);
    },
    [router],
  );

  const run = useCallback(
    async (start: () => Promise<string | null>) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setNotice("");
      try {
        const runId = await start();
        if (runId) await follow(runId);
      } finally {
        busy.current = false;
        if (alive.current) setPending(false);
      }
    },
    [follow],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A check still running when the page opened is carried on once.
  const carried = useRef<string | null>(null);
  useEffect(() => {
    if (!runningId || carried.current === runningId) return;
    carried.current = runningId;
    void run(async () => runningId);
  }, [runningId, run]);

  async function start(): Promise<string | null> {
    const out = await postJson("/api/cards/check");
    if (!alive.current) return null;
    if (!out.ok || typeof out.data.runId !== "string") {
      setNotice(out.error && Object.hasOwn(NOTICE, out.error) ? NOTICE[out.error] : UNKNOWN);
      return null;
    }
    if (out.data.status !== "running") {
      router.refresh();
      return null;
    }
    return out.data.runId;
  }

  return (
    <div className="grid gap-2">
      <Button pending={pending} pendingLabel="Checking..." onClick={() => void run(start)}>
        Check cards
      </Button>
      {notice ? (
        <p role="status" className="text-small text-foreground-2">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
