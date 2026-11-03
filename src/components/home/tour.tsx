"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAgentPanel } from "@/components/agent/panel-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { TourStep } from "@/lib/tour/steps";
import { Unavailable } from "./home-card";

const LINK = "text-small text-link underline-offset-4 hover:underline";

// The walkthrough at the top of Home after a sign-in (?welcome=1): one step at a time, with Back,
// Next, Skip and Done. Inline, never a modal, so the page and the agent's button stay usable under
// it. Closing it is this page's state only: nothing is stored or written, and the next sign-in (or
// "Show me around") opens it again. "Ask about this" opens the agent card with the step's question
// in the box; nothing is sent until the person sends it. Without the agent card on the page there
// is no Ask. With `reopen` (the simple Home, which has no shortcut row), a closed walkthrough
// leaves one quiet "Show me around" link that opens it again at the first step.
export function Tour({ steps, footer, reopen = false }: { steps: readonly TourStep[]; footer: string; reopen?: boolean }) {
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(true);
  const panel = useAgentPanel();
  if (steps.length === 0) return null;
  if (!open) {
    if (!reopen) return null;
    return (
      <p className="min-w-0">
        <button
          type="button"
          onClick={() => {
            setAt(0);
            setOpen(true);
          }}
          className={cn(LINK, "cursor-pointer")}
        >
          Show me around
        </button>
      </p>
    );
  }
  const i = Math.min(at, steps.length - 1);
  const step = steps[i];
  const last = i === steps.length - 1;
  return (
    <section aria-label="Walkthrough" className="min-w-0">
      <Card className="border-l-4 border-l-primary">
        <div className="grid gap-2 px-4 pt-4 sm:px-5">
          <p className="text-small text-foreground-2" aria-live="polite">
            Walkthrough, step {i + 1} of {steps.length}
          </p>
          <h2 className="text-h3 text-foreground">{step.title}</h2>
          {step.lines.map((l) =>
            l.unread ? (
              <Unavailable key={l.text}>{l.text}</Unavailable>
            ) : (
              <p key={l.text} className="text-body text-foreground-2">
                {l.text}
              </p>
            ),
          )}
          {step.link || panel ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
              {step.link ? (
                step.link.href.startsWith("#") ? (
                  <a href={step.link.href} className={LINK}>
                    {step.link.label}
                  </a>
                ) : (
                  <Link href={step.link.href} className={LINK}>
                    {step.link.label}
                  </Link>
                )
              ) : null}
              {panel ? (
                <button
                  type="button"
                  onClick={() => panel.open({ draft: step.ask })}
                  className={cn(LINK, "inline-flex cursor-pointer items-center gap-1.5")}
                >
                  <MessageCircle aria-hidden className="size-4" />
                  Ask about this<span className="sr-only">: {step.title}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 sm:px-5">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Skip
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={i === 0} onClick={() => setAt(i - 1)}>
              Back
            </Button>
            <Button size="sm" onClick={() => (last ? setOpen(false) : setAt(i + 1))}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-small text-foreground-2 sm:px-5">{footer}</p>
      </Card>
    </section>
  );
}
