"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { postJson } from "@/components/invoices/post-json";
import { PAUSE_MESSAGES, messageFor } from "./words";

// The one Pause or Resume button. Any staff member may pause; only an admin may resume
// (POST /api/autopilot/pause checks both). The button shows what a press would do.
export function PauseForm({ paused, canResume }: { paused: boolean; canResume: boolean }) {
  const [isPaused, setIsPaused] = useState(paused);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function press() {
    if (pending) return;
    setPending(true);
    setProblem(null);
    const reply = await postJson("/api/autopilot/pause", { paused: !isPaused });
    if (reply.ok && reply.error === null && typeof reply.data.paused === "boolean") {
      setIsPaused(reply.data.paused);
    } else {
      setProblem(messageFor(PAUSE_MESSAGES, reply.error));
    }
    setPending(false);
  }

  if (isPaused && !canResume) {
    return <p className="text-body text-foreground-2">Only an admin can resume the autopilot.</p>;
  }
  return (
    <div className="grid gap-3">
      <div>
        <Button type="button" variant={isPaused ? "primary" : "destructive"} pending={pending} onClick={() => void press()}>
          {isPaused ? "Resume autopilot" : "Pause autopilot"}
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
