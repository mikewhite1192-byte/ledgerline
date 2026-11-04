"use client";

import { useEffect, useState } from "react";
import { Money } from "@/components/app/money";

const DURATION_MS = 800;

// A stored amount that counts up from zero once, when its step has just turned done. Display only:
// the server renders the stored figure itself, so a page without script, a reduced-motion view and
// every later refresh show it at once, and the count always ends on the stored cents exactly.
export function CountUp({ cents, run, className }: { cents: number; run: boolean; className?: string }) {
  // A fresh step starts at zero, so the stored figure does not flash first. The server never sees a
  // fresh step, so its render is always the stored figure.
  const [shown, setShown] = useState(run ? 0 : cents);

  useEffect(() => {
    setShown(cents);
    if (!run || !Number.isSafeInteger(cents) || cents === 0) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      // Ease out, so the last cents settle rather than snap.
      const eased = 1 - (1 - t) ** 3;
      setShown(t >= 1 ? cents : Math.round(cents * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    setShown(0);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setShown(cents);
    };
  }, [cents, run]);

  return <Money cents={shown} tone="plain" className={className} />;
}
