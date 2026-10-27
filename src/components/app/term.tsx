"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TERMS, type TermId } from "@/lib/format/terms";

// A trucking or pay word with its one-line help (src/lib/format/terms.ts): a dotted underline, the
// help on mouse hover and on keyboard focus, and on a phone a tap shows it under the word and a
// second tap hides it. Escape hides it without moving focus. The help is always the word's
// description for a screen reader, shown or not. Never put one inside a link or a button.
export function Term({ id, children, className }: { id: TermId; children: ReactNode; className?: string }) {
  const helpId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // A touch opens and closes the help by tapping only, so the focus a tap gives does not hold it open.
  const touch = useRef(false);
  const open = !dismissed && (hovered || focused || pinned);

  return (
    <span
      className={cn("relative inline-block", className)}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") {
          setDismissed(false);
          setHovered(true);
        }
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setHovered(false);
      }}
    >
      <button
        type="button"
        aria-describedby={helpId}
        className="cursor-help rounded-sm bg-transparent p-0 text-inherit underline decoration-muted-foreground decoration-dotted decoration-1 underline-offset-4"
        onPointerDown={(e) => {
          touch.current = e.pointerType !== "mouse";
        }}
        onFocus={() => {
          if (touch.current) return;
          setDismissed(false);
          setFocused(true);
        }}
        onBlur={() => {
          touch.current = false;
          setFocused(false);
          setPinned(false);
        }}
        onClick={() => {
          setDismissed(false);
          setPinned((p) => !p);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setDismissed(true);
            setPinned(false);
          }
        }}
      >
        {children}
      </button>
      <span
        role="tooltip"
        id={helpId}
        hidden={!open}
        className="absolute top-full left-0 z-30 mt-1 w-max max-w-[min(18rem,80vw)] rounded-md border border-border bg-popover px-2.5 py-1.5 text-left text-small font-normal text-popover-foreground shadow-float"
      >
        {TERMS[id]}
      </span>
    </span>
  );
}
