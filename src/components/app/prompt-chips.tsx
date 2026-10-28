"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

// A question to start with and one line on why a person would ask it. The label is the question
// the agent receives, word for word; the reason is shown under it and is never sent. fill, when
// set, puts that sentence in the question box for the person to edit and send, instead of asking
// the label at once; help is the line shown under the box then.
export type Suggestion = { id: string; label: string; reason: string; fill?: string; help?: string };

// Three or four questions to start with. Without onPick they show but do nothing (aria-disabled,
// so a screen reader still reads them), which is the home before the agent arrives. Each button is
// named by its question alone, and its reason is read as the button's description.
export function PromptChips({
  prompts,
  onPick,
  className,
}: {
  prompts: Suggestion[];
  onPick?: (id: string) => void;
  className?: string;
}) {
  const off = !onPick;
  const base = useId();
  return (
    <ul className={cn("grid gap-2 sm:grid-cols-2", className)} aria-label="Suggested questions">
      {prompts.map((p, i) => {
        const labelId = `${base}-${i}-label`;
        const reasonId = `${base}-${i}-reason`;
        const reason = p.reason.trim();
        return (
          <li key={p.id} className="flex">
            <button
              type="button"
              aria-disabled={off || undefined}
              aria-labelledby={labelId}
              aria-describedby={reason ? reasonId : undefined}
              onClick={off ? undefined : () => onPick(p.id)}
              className={cn(
                "grid w-full content-start gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors duration-150",
                off
                  ? "cursor-default border-border text-foreground-2"
                  : "cursor-pointer border-input text-foreground hover:border-primary hover:bg-accent",
              )}
            >
              <span id={labelId} className="text-body">
                {p.label}
              </span>
              {reason ? (
                <span id={reasonId} className="text-small text-foreground-2">
                  {reason}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
