import { Check, LoaderCircle, Minus } from "lucide-react";
import type { Checklist as ChecklistData, ChecklistState } from "@/lib/agent/checklist";
import { cn } from "@/lib/cn";

// The plan an answer or a run set first and ticks as it goes (design-agents-101 3.1): one line per
// item, an icon for its state, the item's own words. Each line is read out when it changes; the
// state is said in words too, so color is never the only sign.

const STATE_WORD: Record<ChecklistState, string> = {
  todo: "to do",
  doing: "working on it",
  done: "done",
  skipped: "skipped",
  not_done: "not finished",
};

// Shown beside the item as well as read out: the two states a person needs to see in words.
const SHOWN_WORD: Partial<Record<ChecklistState, string>> = {
  skipped: "Skipped",
  not_done: "Not finished",
};

function StateIcon({ state }: { state: ChecklistState }) {
  if (state === "done")
    return (
      <span className="grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check aria-hidden className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  if (state === "doing") return <LoaderCircle aria-hidden className="size-4 text-primary motion-safe:animate-spin" />;
  if (state === "skipped")
    return (
      <span className="grid size-4 place-items-center rounded-full bg-muted text-muted-foreground">
        <Minus aria-hidden className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  if (state === "not_done") return <span className="block size-4 rounded-full border-2 border-dashed border-warning" />;
  return <span className="block size-4 rounded-full border-2 border-border" />;
}

export function Checklist({ list, className }: { list: ChecklistData; className?: string }) {
  return (
    <div className={cn("grid gap-2 rounded-lg border border-border bg-card px-4 py-3", className)}>
      <p className="text-small font-semibold text-foreground" aria-hidden>
        Checklist
      </p>
      <ul role="list" aria-label="Checklist" aria-live="polite" className="grid gap-1.5">
        {list.items.map((item) => (
          <li key={item.key} aria-atomic="true" className="flex items-start gap-2.5 text-body">
            <span className="mt-0.5 shrink-0">
              <StateIcon state={item.state} />
            </span>
            <span
              className={cn(
                "min-w-0 break-words",
                item.state === "done" || item.state === "skipped" ? "text-foreground-2" : "text-foreground",
              )}
            >
              {item.text}
              {SHOWN_WORD[item.state] ? (
                <span className="ml-2 whitespace-nowrap text-caption text-foreground-2" aria-hidden>
                  {SHOWN_WORD[item.state]}
                </span>
              ) : null}
              <span className="sr-only">, {STATE_WORD[item.state]}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
