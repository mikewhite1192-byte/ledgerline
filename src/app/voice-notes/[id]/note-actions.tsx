"use client";

import { Copy } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { noticeFor } from "@/lib/voice/words";

// The buttons on a note's page: run the next step again, hand the note to the agent, draft the
// reply. Each press is one request; the page reloads to show where the note is. Only fixed
// sentences are shown, never server text.

type Step = "prepare" | "hand-off" | "reply";

const LABELS: Record<Step, { idle: string; pending: string }> = {
  prepare: { idle: "Screen and translate", pending: "Screening and translating" },
  "hand-off": { idle: "Hand to the agent", pending: "The agent is reading the note" },
  reply: { idle: "Draft the reply", pending: "Drafting the reply" },
};

export function NoteActions({ id, steps }: { id: string; steps: Step[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<Step | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(step: Step) {
    if (pending) return;
    setPending(step);
    setNotice(null);
    try {
      const res = await fetch(`/api/voice-notes/${id}/${step}`, { method: "POST" });
      if (!res.ok) {
        let code: unknown = null;
        try {
          code = ((await res.json()) as { error?: unknown }).error;
        } catch {
          code = null;
        }
        setNotice(noticeFor(typeof code === "string" ? code : null));
      }
      router.refresh();
    } catch {
      setNotice(noticeFor(null));
    } finally {
      setPending(null);
    }
  }

  if (steps.length === 0) return null;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {steps.map((step, i) => (
          <Button
            key={step}
            type="button"
            variant={i === 0 ? "primary" : "outline"}
            onClick={() => run(step)}
            disabled={pending !== null && pending !== step}
            pending={pending === step}
            pendingLabel={LABELS[step].pending}
          >
            {LABELS[step].idle}
          </Button>
        ))}
      </div>
      {notice ? <InlineAlert tone="destructive">{notice}</InlineAlert> : null}
    </div>
  );
}

export function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        <Copy aria-hidden /> Copy
      </Button>
      <span role="status" className="text-small text-foreground-2">
        {copied === "yes" ? "Copied." : copied === "no" ? "Copy did not work here; select the text instead." : ""}
      </span>
    </div>
  );
}
