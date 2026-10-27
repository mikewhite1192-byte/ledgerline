"use client";

import { cn } from "@/lib/cn";

// fill, when set, puts that sentence in the question box for the person to edit and send, instead
// of asking the label at once; help is the line shown under the box then.
export type Suggestion = { id: string; label: string; fill?: string; help?: string };

// Three or four questions to start with. Without onPick they show but do nothing (aria-disabled,
// so a screen reader still reads them), which is the home before the agent arrives.
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
  return (
    <ul className={cn("flex flex-wrap gap-2", className)} aria-label="Suggested questions">
      {prompts.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            aria-disabled={off || undefined}
            onClick={off ? undefined : () => onPick(p.id)}
            className={cn(
              "rounded-lg border bg-card px-3 py-2 text-left text-body transition-colors duration-150",
              off
                ? "cursor-default border-border text-foreground-2"
                : "cursor-pointer border-input text-foreground hover:border-primary hover:bg-accent",
            )}
          >
            {p.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
