"use client";

import { useEffect, type RefObject } from "react";

// Closes a native <details> menu on Esc (the cursor back on its summary) and on a pointer down
// outside it. Esc is heard before anything else on the page and is used up when it closes an open
// menu, so a dialog around the menu (the agent card) stays open.
export function useDetailsMenu(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = ref.current;
      if (e.key !== "Escape" || !el?.open) return;
      e.preventDefault();
      el.open = false;
      el.querySelector("summary")?.focus();
    }
    function onPointer(e: PointerEvent) {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [ref]);
}
