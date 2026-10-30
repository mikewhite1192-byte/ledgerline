"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

// A panel that slides in from the left over a dimmed page: a native modal dialog, so focus stays
// inside, Esc closes it and the page behind is inert. A click on the dimmed page closes it too.
// Every way of closing ends in the dialog's own close event, which calls onClose exactly once.
//
// side="right" slides it in from the right. modal={false} opens it beside the page instead (the
// agent panel at laptop width): no dimmed page, the page stays usable, and Esc pressed inside it
// still closes it, since the browser does that only for a modal one.
export function Sheet({
  id,
  open,
  onClose,
  label,
  children,
  className,
  side = "left",
  modal = true,
  closeLabel = "Close menu",
}: {
  id?: string;
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
  side?: "left" | "right";
  modal?: boolean;
  closeLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (modal) dialog.showModal();
      else dialog.show();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, modal]);

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
        if (modal || e.key !== "Escape" || e.defaultPrevented) return;
        // Esc that only cancels a half-typed word (an input method) stays in the box.
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.currentTarget.close();
      }}
      className={cn(
        "scrim fixed inset-y-0 m-0 h-dvh max-h-none w-[min(20rem,calc(100vw-3rem))] max-w-none",
        "border-border bg-card p-0 text-foreground shadow-float",
        side === "left"
          ? "left-0 border-r motion-safe:animate-sheet-in"
          : "right-0 left-auto border-l motion-safe:animate-sheet-in-right",
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div className="absolute top-2.5 right-2.5">
          <Button variant="ghost" size="icon" onClick={() => ref.current?.close()} aria-label={closeLabel}>
            <X aria-hidden />
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
