"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export type ComposerProps = {
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  pending?: boolean;
  className?: string;
};

// The question box. Enter sends, Shift+Enter starts a new line, and the box grows with the text.
// Switched off, it stays readable and focusable (aria-disabled) and says why under the box.
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  disabledReason,
  placeholder = "Ask about pay, advances, invoices or loads",
  pending = false,
  className,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const text = value ?? draft;
  const ref = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();
  const off = disabled || !onSubmit;

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 192)}px`;
  }, [text]);

  function set(next: string) {
    if (value === undefined) setDraft(next);
    onChange?.(next);
  }

  function send() {
    const t = text.trim();
    if (off || pending || !t) return;
    onSubmit?.(t);
    if (value === undefined) setDraft("");
  }

  return (
    <div className={className}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className={cn(
          "flex items-end gap-2 rounded-lg border bg-card p-2 pl-3 transition-colors duration-150",
          "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
          off ? "border-border" : "border-input",
        )}
      >
        <label className="sr-only" htmlFor={`${reasonId}-box`}>
          Your question
        </label>
        <textarea
          ref={ref}
          id={`${reasonId}-box`}
          rows={1}
          value={text}
          readOnly={off}
          aria-disabled={off || undefined}
          aria-describedby={off && disabledReason ? reasonId : undefined}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className={cn(
            "max-h-48 min-h-9 flex-1 resize-none bg-transparent py-2 text-lead text-foreground outline-none md:text-body",
            "placeholder:text-muted-foreground focus-visible:outline-none",
            off && "cursor-not-allowed",
          )}
        />
        <Button type="submit" disabled={off || !text.trim()} pending={pending} pendingLabel="Asking">
          Send
        </Button>
      </form>
      {off && disabledReason ? (
        <p id={reasonId} className="mt-2 text-small text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}
