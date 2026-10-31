"use client";

import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ASK_ANCHOR } from "@/components/app/anchors";
import type { Suggestion } from "@/components/app/prompt-chips";
import { isCardAnchor } from "@/lib/home/card-anchor";
import { AgentPanel, PANEL_ID, type AgentPanelConfig, type PanelRequest } from "./agent-panel";
import { AskCard, AsksContext } from "./ask-card";
import { askDraft } from "./asks";
import type { PageFocus } from "./page-focus";
import { PanelContext, type AgentOpening, type PanelControl } from "./panel-context";
import { useLiveAsks } from "./use-live-asks";
import { ASK_WORDS, badgeCount, moreWaiting } from "./words";

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

// How long the arrival line stays in the polite live region before it clears.
const ANNOUNCE_MS = 3_000;

// The round button at the bottom right of every signed-in page, Home included, the agent card it
// opens, and the "/" shortcut. AppShell renders this while the agent switch is on; with it off
// nothing here renders and no request is made. The card also opens as the page loads when Home
// asks for it (`opening`: ?ask=, ?rule=1, ?document=, ?paystub=, ?new=1) or the address ends in
// #ask or #card-<id>, and again when the hash changes to one of those. Closing the card (Esc, its
// minimize button, the sheet's X on a phone) puts the cursor back on this button. While the
// agent's questions are on (config.asksOn), the button carries how many show now, and the newest
// one this person has not closed slides up above it in a bubble with its buttons; the bubble never
// opens the card by itself and hides while the card is open (the card's thread shows them).
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
    const hash = window.location.hash;
    // A query opening and a #card- link on the same load make one ask that does both.
    if (first) show(isCardAnchor(hash) ? { ...first, scrollTo: hash.slice(1) } : first);
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

  const control = useMemo<PanelControl>(() => ({ open: (opts) => show(opts) }), [show]);

  const asks = useLiveAsks({
    on: config.asksOn === true,
    storeKey: config.asksKey,
    onQuestion: (ask) => show({ draft: askDraft(ask) }),
  });
  const current = open ? null : asks.current;
  const badge = badgeCount(asks.openCount);

  // "New question from the agent", once per question, as it first shows in the bubble.
  const [announce, setAnnounce] = useState("");
  const announced = useRef(new Set<string>());
  const currentId = current?.id ?? null;
  const currentKind = current?.kind ?? null;
  useEffect(() => {
    if (currentId === null || announced.current.has(currentId)) return;
    // Cleared first, so a line still held for the last question is read again for this one.
    const clear = setTimeout(() => setAnnounce(""), 50);
    const say = setTimeout(() => {
      announced.current.add(currentId);
      setAnnounce(currentKind === "told" ? ASK_WORDS.arrivedTold : ASK_WORDS.arrivedAsk);
    }, 100);
    return () => {
      clearTimeout(clear);
      clearTimeout(say);
    };
  }, [currentId, currentKind]);
  // When the bubble goes (Got it, Not now, Yes settled, the x) with the cursor lost to the page,
  // it goes back to the button. A card that opened, or a cursor the person moved, is left alone.
  const hadBubble = useRef(false);
  useEffect(() => {
    const has = currentId !== null;
    if (hadBubble.current && !has && !open) {
      const at = document.activeElement;
      if (!at || at === document.body) button.current?.focus();
    }
    hadBubble.current = has;
  }, [currentId, open]);
  useEffect(() => {
    if (!announce) return;
    const quiet = setTimeout(() => setAnnounce(""), ANNOUNCE_MS);
    return () => clearTimeout(quiet);
  }, [announce]);

  return (
    <PanelContext.Provider value={control}>
      <AsksContext.Provider value={asks.control}>
        {children}
        <p className="sr-only" aria-live="polite" data-testid="ask-announcer">
          {announce}
        </p>
        {current ? (
          <section
            aria-label={ASK_WORDS.region}
            className="fixed right-4 bottom-[4.75rem] left-4 z-30 motion-safe:animate-rise sm:right-6 sm:bottom-[5.25rem] sm:left-auto sm:w-[360px] print:hidden"
          >
            <AskCard
              ask={current}
              state={asks.control.states[current.id]}
              control={asks.control}
              more={moreWaiting(asks.more)}
              onClose={() => asks.dismiss(current.id)}
              className="shadow-float"
            />
          </section>
        ) : null}
        <button
          ref={button}
          type="button"
          aria-label={badge ? `Ask the agent, ${asks.openCount} waiting` : "Ask the agent"}
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
          {badge ? (
            <span
              aria-hidden
              data-testid="ask-badge"
              className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full border-2 border-background bg-destructive px-1 text-caption leading-none font-semibold text-destructive-foreground"
            >
              {badge}
            </span>
          ) : null}
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
      </AsksContext.Provider>
    </PanelContext.Provider>
  );
}
