"use client";

import { Bell, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ASK_ANCHOR, NEEDS_YOU_ANCHOR } from "./anchors";
import { HideAmounts } from "./hide-amounts";

const ASK_HREF = `/#${ASK_ANCHOR}`;

// Home's question box, when it is on the page and can take a question.
function composer(): HTMLTextAreaElement | null {
  const box = document.getElementById(ASK_ANCHOR)?.querySelector("textarea");
  return box && !box.readOnly ? box : null;
}

function focusComposer(box: HTMLTextAreaElement) {
  box.scrollIntoView?.({ block: "center" });
  box.focus({ preventScroll: true });
}

// "Ask" goes to the agent on Home. Already on Home, it puts the cursor in the question box instead
// of reloading; a click with a modifier key still opens a new tab. The wait lets the phone menu
// close and hand focus back before the box takes it.
function onAsk(e: MouseEvent<HTMLAnchorElement>) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const box = composer();
  if (!box) return;
  e.preventDefault();
  window.setTimeout(() => focusComposer(box), 0);
}

export function AskLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Link href={ASK_HREF} onClick={onAsk} className={className}>
      {children}
    </Link>
  );
}

// The wide box in the top bar. It is the agent, not a separate search: it reads like a field and
// takes you to the question box. Arriving on Home from another page with #ask, it focuses the box.
function AskBox() {
  useEffect(() => {
    const wait = window.setTimeout(() => {
      if (window.location.hash !== `#${ASK_ANCHOR}`) return;
      const box = composer();
      if (box) focusComposer(box);
    }, 0);
    return () => window.clearTimeout(wait);
  }, []);
  return (
    <AskLink
      className={cn(
        "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-card px-3 text-body text-muted-foreground",
        "transition-colors duration-150 hover:border-foreground-2 hover:text-foreground-2 md:max-w-md",
      )}
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="truncate">Search or ask anything</span>
    </AskLink>
  );
}

// "Test mode" with a dot, to the accounting settings. On a phone only the dot shows; the banner
// above already says it in full.
function TestModeChip() {
  return (
    <Link
      href="/settings/accounting"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-warning-soft px-2.5 text-caption text-warning"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-warning" />
      <span className="max-sm:sr-only">Test mode</span>
    </Link>
  );
}

// The bell: to Home's Needs you list, with a dot while anything waits. The count comes from the
// page's own Needs you read (Home has it); a page without it shows the bell with no dot.
function NeedsYouBell({ count }: { count?: number }) {
  const waiting = count !== undefined && count > 0;
  return (
    <Link
      href={`/#${NEEDS_YOU_ANCHOR}`}
      aria-label={waiting ? `Needs you, ${count} waiting` : "Needs you"}
      className="relative grid size-9 shrink-0 place-items-center rounded-lg text-foreground transition-colors duration-150 hover:bg-accent"
    >
      <Bell aria-hidden className="size-4" />
      {waiting ? (
        <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-primary ring-2 ring-background" />
      ) : null}
    </Link>
  );
}

// The bar across the top of every signed-in page: the menu button under laptop width, the agent's
// box, then the test-mode chip, the hide-amounts eye and the bell. `offset` keeps it under the
// test-mode banner at laptop width, where the banner stays put.
export function TopBar({
  menu,
  agentOn,
  testMode,
  needsYouCount,
  offset,
}: {
  menu: ReactNode;
  agentOn: boolean;
  testMode: boolean;
  needsYouCount?: number;
  offset: boolean;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur-sm md:gap-3 md:px-6",
        offset && "lg:top-9",
      )}
    >
      {menu}
      {agentOn ? <AskBox /> : <span className="flex-1" />}
      <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
        {testMode ? <TestModeChip /> : null}
        <HideAmounts />
        <NeedsYouBell count={needsYouCount} />
      </div>
    </header>
  );
}
