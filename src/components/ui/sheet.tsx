"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

// A panel that slides in from the left over a dimmed page: a native modal dialog, so focus stays
// inside, Esc closes it and the page behind is inert. A click on the dimmed page closes it too.
export function Sheet({
  open,
  onClose,
  label,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "scrim fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(20rem,calc(100vw-3rem))] max-w-none",
        "border-r border-border bg-card p-0 text-foreground shadow-float motion-safe:animate-sheet-in",
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div className="absolute top-2.5 right-2.5">
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close menu">
            <X aria-hidden />
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
