"use client";

import { ArrowUp, Plus, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { suggestionIcon } from "@/components/agent/suggestion-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { Suggestion } from "./prompt-chips";

// The pill's "+" menu: the suggested questions again (they leave the thread once a question is
// asked) and, while documents are on, the way to upload one. There is no attach path in the chat
// itself; the documents page owns uploads.
export type ComposerMenuProps = {
  suggestions: Suggestion[];
  // Unset while the agent cannot answer: the questions are left out, the upload link stays.
  onPick?: (id: string) => void;
  documentsHref?: string;
};

export type ComposerProps = {
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  pending?: boolean;
  // A line of help under the box while it is on (a suggestion that fills the box sets it).
  help?: string;
  className?: string;
  // "box" is the wide box with a Send button; "pill" is the agent card's: a rounded pill with the
  // "+" menu on the left and a round send arrow on the right.
  variant?: "box" | "pill";
  menu?: ComposerMenuProps;
};

const PILL_PLACEHOLDER = "Ask a question or give a command";

function ComposerMenu({ suggestions, onPick, documentsHref }: ComposerMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const questions = onPick ? suggestions : [];

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function onPointer(e: PointerEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function close() {
    setOpen(false);
    plus.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (e.key === "Escape") {
      // Used up here, so the card around the box stays open.
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  }

  const item =
    "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-body text-foreground transition-colors duration-150 hover:bg-accent focus-visible:bg-accent";
  return (
    <div
      ref={wrap}
      className="self-end"
      onKeyDown={onKey}
      // Tabbing out of the open menu closes it, as a click outside does. Focus going nowhere (a
      // browser that blurs on a click before the click lands) leaves it to the click.
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (open && to instanceof Node && !wrap.current?.contains(to)) setOpen(false);
      }}
    >
      <Button
        ref={plus}
        variant="ghost"
        size="icon"
        className="size-8 rounded-full"
        aria-label="More ways to ask"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus aria-hidden />
      </Button>
      {open ? (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label="More ways to ask"
          className="absolute right-0 bottom-full left-0 z-10 mb-2 grid max-h-64 gap-0.5 overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-float motion-safe:animate-rise"
        >
          {questions.map((s) => {
            const Icon = suggestionIcon(s.id);
            return (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={item}
                onClick={() => {
                  setOpen(false);
                  onPick?.(s.id);
                }}
              >
                <Icon aria-hidden className="size-4 shrink-0 text-foreground-2" />
                <span className="min-w-0">{s.label}</span>
              </button>
            );
          })}
          {documentsHref ? (
            <Link href={documentsHref} role="menuitem" tabIndex={-1} className={item} onClick={() => setOpen(false)}>
              <Upload aria-hidden className="size-4 shrink-0 text-foreground-2" />
              Upload a document
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The question box. Enter sends, Shift+Enter starts a new line, and the box grows with the text.
// Switched off, it stays readable and focusable (aria-disabled) and says why under the box.
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  disabledReason,
  placeholder,
  pending = false,
  help,
  className,
  variant = "box",
  menu,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const text = value ?? draft;
  const ref = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();
  const off = disabled || !onSubmit;
  const pill = variant === "pill";
  // The pill grows to about four lines; the box to about eight.
  const tallest = pill ? 112 : 192;
  const withMenu =
    pill && menu !== undefined && ((menu.onPick !== undefined && menu.suggestions.length > 0) || Boolean(menu.documentsHref));

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, tallest)}px`;
  }, [text, tallest]);

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
        className={
          pill
            ? cn(
                "relative flex items-end gap-1.5 rounded-[1.5rem] border-2 bg-card p-1.5 transition-colors duration-150",
                "border-border focus-within:border-input",
              )
            : cn(
                "flex items-end gap-2 rounded-lg border bg-card p-2 pl-3 transition-colors duration-150",
                "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
                off ? "border-border" : "border-input",
              )
        }
      >
        {withMenu && menu ? <ComposerMenu {...menu} /> : null}
        <label className="sr-only" htmlFor={`${reasonId}-box`}>
          Your question
        </label>
        <textarea
          ref={ref}
          id={`${reasonId}-box`}
          data-composer=""
          rows={1}
          value={text}
          readOnly={off}
          aria-disabled={off || undefined}
          aria-describedby={off && disabledReason ? reasonId : !off && help ? `${reasonId}-help` : undefined}
          placeholder={placeholder ?? (pill ? PILL_PLACEHOLDER : "Ask about pay, advances, invoices or loads")}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className={cn(
            "flex-1 resize-none bg-transparent text-lead text-foreground outline-none md:text-body",
            "placeholder:text-muted-foreground focus-visible:outline-none",
            pill ? "max-h-28 min-h-8 py-1.5" : "max-h-48 min-h-9 py-2",
            pill && !withMenu && "pl-2.5",
            off && "cursor-not-allowed",
          )}
        />
        {pill ? (
          <Button
            type="submit"
            size="icon"
            disabled={off || !text.trim()}
            pending={pending}
            pendingLabel={<span className="sr-only">Asking</span>}
            aria-label={pending ? "Asking" : "Send"}
            className="size-8 rounded-full disabled:bg-secondary disabled:text-foreground-2 disabled:opacity-100"
          >
            <ArrowUp aria-hidden />
          </Button>
        ) : (
          <Button type="submit" disabled={off || !text.trim()} pending={pending} pendingLabel="Asking">
            Send
          </Button>
        )}
      </form>
      {off && disabledReason ? (
        <p id={reasonId} className={cn("mt-2 text-small text-muted-foreground", pill && "px-2")}>
          {disabledReason}
        </p>
      ) : !off && help ? (
        <p id={`${reasonId}-help`} className={cn("mt-2 text-small text-muted-foreground", pill && "px-2")}>
          {help}
        </p>
      ) : null}
    </div>
  );
}
