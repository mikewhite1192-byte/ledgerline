"use client";

import { useState } from "react";
import { InlineAlert } from "@/components/ui/inline-alert";
import { postJson } from "@/components/invoices/post-json";
import { DEMO_FAULTS, FAULT_WORDS, readDemoFaults, type DemoFault, type DemoFaults } from "@/lib/adapters/tms-source/faults";

// A fixed message per category; nothing the server says is shown.
export const TMS_FAULT_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "The fault switches are off for this carrier. Nothing was changed.",
  role: "Only an admin of this carrier can change the faults. Nothing was changed.",
  bad_request: "That change was not understood. Nothing was changed.",
  forbidden: "Only an admin of this carrier can change the faults. Nothing was changed.",
  unknown: "The change did not confirm. Reload this page to see the switches as saved.",
};

const FALLBACK = "Could not save the change. Try again in a moment.";

// The demo dispatch feed's fault switches: each one makes the feed act like a messy real dispatch
// system in one way. Flipping one saves it at once; the next sync reads the feed with it.
export function TmsFaultsForm({ initial }: { initial: DemoFaults }) {
  const [faults, setFaults] = useState<DemoFaults>(initial);
  const [pending, setPending] = useState<DemoFault | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function flip(fault: DemoFault, on: boolean) {
    if (pending) return;
    setPending(fault);
    setProblem(null);
    const reply = await postJson("/api/demo/tms-faults", { [fault]: on });
    if (reply.ok && reply.error === null) {
      setFaults(readDemoFaults(reply.data.faults));
    } else {
      const text = (reply.error && Object.hasOwn(TMS_FAULT_MESSAGES, reply.error) ? TMS_FAULT_MESSAGES[reply.error] : null) ?? FALLBACK;
      setProblem(text);
    }
    setPending(null);
  }

  return (
    <div className="grid gap-3">
      {DEMO_FAULTS.map((f) => (
        <label key={f} className="flex items-start gap-2 text-body text-foreground">
          <input
            type="checkbox"
            name={f}
            checked={faults[f]}
            disabled={pending !== null}
            onChange={(e) => void flip(f, e.currentTarget.checked)}
            className="mt-1 size-4 shrink-0"
          />
          <span className="grid gap-0.5">
            <span>{FAULT_WORDS[f].title}</span>
            <span className="text-foreground-2">{FAULT_WORDS[f].detail}</span>
          </span>
        </label>
      ))}
      {problem ? (
        <InlineAlert tone="destructive" className="w-full">
          {problem}
        </InlineAlert>
      ) : null}
    </div>
  );
}
