"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { buildCopyAction } from "./actions";

// Calls the build one slice at a time until the copy is ready, then opens it. A failed slice is
// tried again a few times (the build picks up where it stopped); after that the visitor gets a
// plain line and a way out.
const TRIES = 3;

export function Preparing({ landing }: { landing: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let stopped = false;
    void (async () => {
      let misses = 0;
      while (!stopped) {
        let state: Awaited<ReturnType<typeof buildCopyAction>>;
        try {
          state = await buildCopyAction();
        } catch {
          state = { state: "failed" };
        }
        if (state.state === "ready") {
          setProgress(100);
          router.replace(landing);
          return;
        }
        if (state.state === "leave") {
          router.replace(state.to);
          return;
        }
        if (state.state === "building") {
          misses = 0;
          setProgress(Math.min(99, Math.floor((state.tablesDone * 100) / Math.max(1, state.tablesTotal))));
          continue;
        }
        misses += 1;
        if (misses >= TRIES) {
          setFailed(true);
          return;
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [router, landing]);

  if (failed) {
    return (
      <div className="grid gap-4">
        <InlineAlert tone="destructive">
          Your carrier could not be set up right now. Please sign out and try the demo again.
        </InlineAlert>
        <form action="/api/auth/sign-out" method="post">
          <Button type="submit" variant="outline" size="lg" className="w-full">
            Sign out
          </Button>
        </form>
      </div>
    );
  }
  return (
    <div className="grid gap-2" role="status" aria-live="polite">
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.max(5, progress)}%` }} />
      </div>
      <p className="text-small text-foreground-2">This takes a moment.</p>
    </div>
  );
}
