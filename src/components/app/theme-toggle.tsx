"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useId, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "pc-theme";

function read(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

function subscribe(onChange: () => void) {
  const watcher = new MutationObserver(onChange);
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => watcher.disconnect();
}

// Sets the mode on <html> (or clears it for System) and remembers it for the next visit. The
// script in public/theme.js applies the saved choice before first paint.
export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage can be off (private mode); the choice still holds for this page.
  }
}

const OPTIONS = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

export function ThemeToggle({ className }: { className?: string }) {
  const current = useSyncExternalStore(subscribe, read, () => "system" as const);
  const group = useId();
  return (
    <fieldset className={cn("grid gap-1.5", className)}>
      <legend className="mb-1.5 text-small text-muted-foreground">Appearance</legend>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1">
        {OPTIONS.map(({ value, label, Icon }) => (
          <label
            key={value}
            className={cn(
              "flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md text-small font-medium transition-colors duration-150",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-ring",
              current === value
                ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "text-foreground-2 hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={group}
              value={value}
              checked={current === value}
              onChange={() => applyTheme(value)}
              className="sr-only"
            />
            <Icon aria-hidden className="size-3.5" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
