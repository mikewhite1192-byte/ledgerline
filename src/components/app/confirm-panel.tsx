"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { Money } from "./money";

export type ConfirmItem = { key: string; label: ReactNode; cents?: number };

export type ConfirmPanelProps = {
  // Verb and object, as a question: "Approve 23 paystubs?"
  question: string;
  // Count and total: "23 drivers, $31,482.15 in total."
  summary?: ReactNode;
  // What is confirmed, listed only when there is more than one.
  items?: readonly ConfirmItem[];
  // What happens next, one sentence: "Each driver's pay goes to their bank by test payout."
  next: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Reject and other undoing actions: the confirm button takes the destructive look.
  tone?: "default" | "destructive";
  pending?: boolean;
  pendingLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
};

// One shape for every approval and outside write a page asks for: the question, the count and
// total, the list when more than one, what happens next, then Confirm and Keep reviewing. Focus
// starts on Keep reviewing, the safe choice. It only asks: what runs on Confirm is the caller's,
// unchanged.
export function ConfirmPanel({
  question,
  summary,
  items = [],
  next,
  confirmLabel = "Confirm",
  cancelLabel = "Keep reviewing",
  tone = "default",
  pending = false,
  pendingLabel,
  onConfirm,
  onCancel,
  className,
}: ConfirmPanelProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn("grid gap-3 rounded-lg border border-border bg-secondary px-4 py-3 sm:px-5", className)}
    >
      <div className="grid gap-1">
        <p id={titleId} className="text-body font-semibold text-foreground">
          {question}
        </p>
        {summary ? <p className="text-body text-foreground">{summary}</p> : null}
      </div>
      {items.length > 1 ? (
        <ul aria-label="Included" className="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-border bg-card px-3 py-2">
          {items.map((item) => (
            <li key={item.key} className="flex items-baseline justify-between gap-4 text-body">
              <span className="min-w-0 text-foreground">{item.label}</span>
              {item.cents === undefined ? null : <Money cents={item.cents} className="shrink-0" />}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-small text-foreground-2">{next}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button ref={cancelRef} variant="outline" disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={tone === "destructive" ? "destructive" : "primary"}
          pending={pending}
          pendingLabel={pendingLabel}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
