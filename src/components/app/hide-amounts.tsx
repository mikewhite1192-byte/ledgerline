"use client";

import { Eye, EyeOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

export const AMOUNTS_KEY = "pc-amounts";

function read(): boolean {
  return document.documentElement.dataset.amounts === "hidden";
}

function subscribe(onChange: () => void) {
  const watcher = new MutationObserver(onChange);
  watcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-amounts"],
  });
  return () => watcher.disconnect();
}

// Puts data-amounts="hidden" on <html> (or takes it off) and remembers it for the next visit; the
// script in public/theme.js applies the saved choice before first paint. Only the page-wide
// attribute changes: an amount inside data-amounts="shown" (a card a person approves) keeps
// showing, because that attribute sits on its own element and is never touched here.
export function applyAmounts(hidden: boolean) {
  const root = document.documentElement;
  if (hidden) root.dataset.amounts = "hidden";
  else delete root.dataset.amounts;
  try {
    if (hidden) localStorage.setItem(AMOUNTS_KEY, "hidden");
    else localStorage.removeItem(AMOUNTS_KEY);
  } catch {
    // Storage can be off (private mode); the choice still holds for this page.
  }
}

// The eye in the top bar: pressed means amounts are hidden. Good for a screen share or a demo.
export function HideAmounts() {
  const hidden = useSyncExternalStore(subscribe, read, () => false);
  const Icon = hidden ? EyeOff : Eye;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Hide amounts"
      aria-pressed={hidden}
      title={hidden ? "Show amounts" : "Hide amounts"}
      // The page itself says what is on now, so two quick clicks never both hide.
      onClick={() => applyAmounts(!read())}
    >
      <Icon aria-hidden />
    </Button>
  );
}
