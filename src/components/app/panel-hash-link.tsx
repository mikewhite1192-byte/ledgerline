"use client";

import type { MouseEvent, ReactNode } from "react";
import { useAgentPanel } from "@/components/agent/panel-context";
import { isCardAnchor } from "@/lib/home/card-anchor";
import { ASK_ANCHOR } from "./anchors";

// A plain left click, no modifier key: the only click a link hands to the agent card. Any other
// click keeps the browser's own behavior (a new tab, a new window, a download).
export function plainClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

// A same-page link to #ask or #card-<id>. With the agent card on the page, a plain click opens the
// card itself, so the link works again after the card was closed, when the address already ends in
// that hash and the browser fires no hashchange. Without a card, or for any other hash, it is a
// plain link.
export function PanelHashLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const panel = useAgentPanel();
  const ask = href === `#${ASK_ANCHOR}`;
  const card = isCardAnchor(href);
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (!panel || (!ask && !card) || !plainClick(e)) return;
    e.preventDefault();
    panel.open(card ? { scrollTo: href.slice(1) } : undefined);
  }
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
