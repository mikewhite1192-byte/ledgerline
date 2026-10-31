"use client";

import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ASK_ANCHOR } from "@/components/app/anchors";
import type { Suggestion } from "@/components/app/prompt-chips";
import { isCardAnchor } from "@/lib/home/card-anchor";
import { AgentPanel, PANEL_ID, type AgentPanelConfig, type PanelRequest } from "./agent-panel";
import type { PageFocus } from "./page-focus";
import { PanelContext, type AgentOpening, type OpenRequest } from "./panel-context";

// Laptop width, where the card floats at the bottom right; narrower, it is the modal sheet. Read
// when it opens. Without a media query to ask, it floats.
function floats(): boolean {
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

// The round button at the bottom right of every signed-in page, Home included, the agent card it
// opens, and the "/" shortcut. AppShell renders this while the agent switch is on; with it off
// nothing here renders and no request is made. The card also opens as the page loads when Home
// asks for it (`opening`: ?ask=, ?rule=1, ?document=, ?paystub=, ?new=1) or the address ends in
// #ask or #card-<id>, and again when the hash changes to one of those. Closing the card (Esc, its
// minimize button, the sheet's X on a phone) puts the cursor back on this button.
export function AgentLauncher({
  config,
  focus,
  suggestions,
  opening,
  children,
}: {
  config: AgentPanelConfig;
  focus?: PageFocus;
  suggestions: Suggestion[];
  opening?: AgentOpening;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const [started, setStarted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [request, setRequest] = useState<PanelRequest>({ n: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const isOpen = useRef(false);
  const wasOpen = useRef(false);
  const arrived = useRef(false);
  const firstOpening = useRef(opening);

  const show = useCallback((opts: Omit<PanelRequest, "n"> = {}) => {
    // The mode is picked once per opening, so a resize never swaps it under the person.
    if (!isOpen.current) setModal(!floats());
    isOpen.current = true;
    setStarted(true);
    setOpen(true);
    setRequest((r) => ({ ...opts, n: r.n + 1 }));
  }, []);

  const closed = useCallback(() => {
    isOpen.current = false;
    setOpen(false);
    setExpanded(false);
  }, []);

  // The button is hidden while the card covers its corner, so the cursor goes back to it only
  // once it shows again, after the close.
  useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const fromHash = useCallback(() => {
    const hash = window.location.hash;
    if (hash === `#${ASK_ANCHOR}`) show();
    else if (isCardAnchor(hash)) show({ scrollTo: hash.slice(1) });
  }, [show]);

  // Once per page load (the guard keeps a second run of the effect from opening it twice).
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const first = firstOpening.current;
    if (first) show(first);
    else fromHash();
  }, [show, fromHash]);

  useEffect(() => {
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [fromHash]);

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

  const control = useMemo(() => ({ open: (opts?: OpenRequest) => show(opts) }), [show]);

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
          // The floating card covers this corner; hidden, the button is out of sight and out of
          // the tab order until the card closes.
          open && !modal && "invisible",
        )}
      >
        <MessageCircle aria-hidden className="size-5" />
      </button>
      {started ? (
        <AgentPanel
          open={open}
          modal={modal}
          expanded={expanded}
          onExpand={setExpanded}
          onClose={closed}
          focus={focus}
          config={config}
          suggestions={suggestions}
          request={request}
        />
      ) : null}
    </PanelContext.Provider>
  );
}
