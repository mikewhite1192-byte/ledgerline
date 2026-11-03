"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Keeps an open feed page current: every pollSeconds, while the tab is visible and the person has
// not paused it, the page reads itself again (a server render; nothing here writes). Pause stops
// that until Resume.
export function LiveRefresh({ pollSeconds }: { pollSeconds: number }) {
  const router = useRouter();
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live || !Number.isSafeInteger(pollSeconds) || pollSeconds < 1) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, pollSeconds * 1000);
    return () => clearInterval(timer);
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
