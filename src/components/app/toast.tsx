"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ToastTone = "neutral" | "success" | "warning" | "destructive";
export type ToastInput = {
  title: string;
  body?: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
};
type ToastItem = ToastInput & { id: number };

// Neutral and success news leaves on its own; a warning, an error or a toast with an action stays
// until it is dismissed or acted on. A timed toast waits while the pointer or focus is on it.
export const TOAST_TIMEOUT_MS = 6000;
export const TOAST_LIMIT = 3;
const STAYS: ReadonlySet<ToastTone> = new Set(["warning", "destructive"]);

const ICONS = { neutral: Info, success: CircleCheck, warning: TriangleAlert, destructive: CircleAlert };
const ICON_COLOR = {
  neutral: "text-info",
  success: "text-primary",
  warning: "text-warning",
  destructive: "text-destructive",
};

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function useToast(): (t: ToastInput) => void {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast needs a ToastProvider above it");
  return toast;
}

// One toast, as it appears in the stack. Exported so /design can show each tone at rest.
export function ToastView({
  title,
  body,
  tone = "neutral",
  action,
  onDismiss,
  className,
}: ToastInput & { onDismiss?: () => void; className?: string }) {
  const Icon = ICONS[tone];
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-border bg-popover p-3 pr-2 text-popover-foreground shadow-float",
        className,
      )}
      data-tone={tone}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", ICON_COLOR[tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold">{title}</p>
        {body ? <p className="mt-0.5 text-body text-foreground-2">{body}</p> : null}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-1.5 cursor-pointer text-body font-medium text-link underline-offset-4 hover:underline"
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <X aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

function TimedToast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const tone = item.tone ?? "neutral";
  const timed = !STAYS.has(tone) && !item.action;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useEffect(() => {
    // Leaving the toast starts the full time again, so nobody loses it mid-read.
    if (!timed || paused) return;
    const timer = setTimeout(() => onDismiss(item.id), TOAST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [item.id, timed, paused, onDismiss]);
  const action = item.action;
  return (
    <li
      className="motion-safe:animate-rise"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // Focus moving between this toast's own buttons keeps it paused.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <ToastView
        {...item}
        action={
          action
            ? {
                label: action.label,
                onClick: () => {
                  action.onClick();
                  onDismiss(item.id);
                },
              }
            : undefined
        }
        onDismiss={() => onDismiss(item.id)}
      />
    </li>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const toast = useCallback((t: ToastInput) => {
    const id = next.current++;
    // At most three: the oldest makes room for the newest.
    setItems((prev) => [...prev, { ...t, id }].slice(-TOAST_LIMIT));
  }, []);
  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[22rem]"
      >
        <ol className="grid gap-2">
          {items.map((item) => (
            <TimedToast key={item.id} item={item} onDismiss={dismiss} />
          ))}
        </ol>
      </div>
    </ToastContext.Provider>
  );
}
