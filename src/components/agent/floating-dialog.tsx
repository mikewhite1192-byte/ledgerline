"use client";

import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { closeOnEscape, useDialog } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";

// The agent's dialog. At laptop width it is a rounded card floating at the bottom right, opened
// beside the page (non-modal), so the page behind stays usable and nothing on it moves; Esc pressed
// inside closes it. Expanded, it grows to a larger card, still clear of the top bar. On a phone
// (modal) it is the sheet from the right, as the menu's: focus kept inside, the page dimmed and
// inert, closed by its X, Esc or a click on the dimmed page. One dialog element serves both, so the
// thread inside is never remounted when the next opening picks the other mode. Every way of
// closing ends in the dialog's own close event, which calls onClose once.
export function FloatingDialog({
  id,
  open,
  modal,
  onClose,
  label,
  expanded,
  closeLabel,
  children,
}: {
  id: string;
  open: boolean;
  modal: boolean;
  onClose: () => void;
  label: string;
  expanded: boolean;
  closeLabel: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useDialog(ref, open, modal);
  return (
    <dialog
      ref={ref}
      id={id}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (modal && e.target === e.currentTarget) e.currentTarget.close();
      }}
      onKeyDown={(e) => {
        if (!modal) closeOnEscape(e);
      }}
      data-expanded={expanded && !modal ? "" : undefined}
      className={cn(
        "m-0 max-h-none max-w-none overflow-hidden bg-card p-0 text-foreground",
        modal
          ? "scrim fixed inset-y-0 right-0 left-auto h-dvh w-full border-l border-border shadow-float motion-safe:animate-sheet-in-right sm:w-[420px]"
          : cn(
              "fixed inset-auto right-6 bottom-6 z-40 rounded-[24px] border border-border shadow-lift motion-safe:animate-rise",
              expanded
                ? "h-[calc(100dvh-7rem)] w-[min(720px,calc(100vw-3rem))]"
                : "h-[min(560px,calc(100dvh-6rem))] w-[420px]",
            ),
      )}
    >
      <div className="flex h-full flex-col">
        {modal ? (
          <div className="absolute top-2.5 right-2.5">
            <Button variant="ghost" size="icon" onClick={() => ref.current?.close()} aria-label={closeLabel}>
              <X aria-hidden />
            </Button>
          </div>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}
