"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Keeps an open feed page current: every pollSeconds, while the tab is visible and the person has
// not paused it, the page reads itself again (a server render; nothing here writes). The timer
// stops while the tab is hidden and starts again when it shows. Pause stops it until Resume.
export function LiveRefresh({ pollSeconds }: { pollSeconds: number }) {
  const router = useRouter();
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live || !Number.isSafeInteger(pollSeconds) || pollSeconds < 1) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const sync = () => {
      if (document.visibilityState !== "visible") return stop();
      if (timer === null) timer = setInterval(() => router.refresh(), pollSeconds * 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stop();
    };
  }, [live, pollSeconds, router]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span role="status">
        <Badge tone={live ? "success" : "neutral"}>{live ? "Live" : "Paused"}</Badge>
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => setLive((v) => !v)}>
        {live ? "Pause" : "Resume"}
      </Button>
    </div>
  );
}
