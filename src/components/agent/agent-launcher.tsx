"use client";

import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { AgentPanel, PANEL_ID, type AgentPanelConfig } from "./agent-panel";
import type { PageFocus } from "./page-focus";
import { PanelContext } from "./panel-context";

// Laptop width, where the panel opens beside the page; narrower, it is the modal sheet. Read when
// it opens. Without a media query to ask, it opens beside the page.
function besidePage(): boolean {
  try {
    return typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 64rem)").matches;
  } catch {
    return true;
  }
}

// A slash typed into a field is the person's text, never the shortcut.
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) !== null
  );
}

// Another dialog open (the phone menu, a confirm sheet) keeps the keyboard; the shortcut waits.
function otherDialogOpen(): boolean {
  return Array.from(document.querySelectorAll("dialog[open]")).some((d) => d.id !== PANEL_ID);
}

// The round button at the bottom right of a signed-in page, the agent panel it opens, and the
// "/" shortcut. AppShell renders this only off Home and only while the agent and page focus
// switches are both on; with either off nothing here renders and no request is made. Closing the
// panel (Esc, its close button, this button again) puts the cursor back on this button.
export function AgentLauncher({
  config,
  focus,
  children,
}: {
  config: AgentPanelConfig;
  focus?: PageFocus;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const [started, setStarted] = useState(false);
  const [boxRequest, setBoxRequest] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const isOpen = useRef(false);

  const show = useCallback(() => {
    // The mode is picked once per opening, so a resize never swaps it under the person.
    if (!isOpen.current) setModal(!besidePage());
    isOpen.current = true;
    setStarted(true);
    setOpen(true);
    setBoxRequest((n) => n + 1);
  }, []);

  const closed = useCallback(() => {
    isOpen.current = false;
    setOpen(false);
    button.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Shift is how some keyboards type a slash, so only the command keys count as a modifier.
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      if (typingIn(e.target) || otherDialogOpen()) return;
      e.preventDefault();
      show();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [show]);

  // Beside the page at wide widths, the page makes room for the panel (globals.css).
  useEffect(() => {
    const root = document.documentElement;
    if (open && !modal) root.dataset.agentPanel = "open";
    else delete root.dataset.agentPanel;
    return () => {
      delete root.dataset.agentPanel;
    };
  }, [open, modal]);

  const control = useMemo(() => ({ open: show }), [show]);

  return (
    <PanelContext.Provider value={control}>
      {children}
      <button
        ref={button}
        type="button"
        aria-label="Ask the agent"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={started ? PANEL_ID : undefined}
        onClick={() => {
          if (isOpen.current) {
            isOpen.current = false;
            setOpen(false);
          } else {
            show();
          }
        }}
        className={cn(
          "fixed right-4 bottom-4 z-30 grid size-12 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground shadow-float sm:right-6 sm:bottom-6",
          "transition-colors duration-150 hover:bg-primary-hover focus-visible:outline-offset-4 print:hidden",
          // Open beside the page, the button moves to the panel's left edge so it stays in reach.
          open && !modal && "sm:right-[calc(420px+1.5rem)]",
        )}
      >
        <MessageCircle aria-hidden className="size-5" />
      </button>
      {started ? (
        <AgentPanel
          open={open}
          modal={modal}
          onClose={closed}
          focus={focus}
          config={config}
          boxRequest={boxRequest}
        />
      ) : null}
    </PanelContext.Provider>
  );
}
