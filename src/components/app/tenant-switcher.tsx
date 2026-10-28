"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Role } from "@/lib/roles";
import { cn } from "@/lib/cn";
import { zoneName } from "@/lib/format/dates";
import { ThemeToggle } from "./theme-toggle";

// role is the membership's, read with the rest; a fixture without one shows as staff.
export type TenantInfo = { name: string; email: string; timezone: string; role?: Role };

// Two letters for the carrier chip: the first letters of the first two words, else the first two
// letters of the one word.
export function initials(name: string): string {
  const [first, second] = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!first) return "?";
  const pick = second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2);
  return pick.toUpperCase();
}

function Initials({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-success-soft text-caption font-semibold text-success",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

// What the open menu shows. Exported so /design can show it at rest, without the floating chrome.
export function TenantPanel({
  tenant,
  signOut,
  className,
}: {
  tenant: TenantInfo;
  signOut: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid w-80 max-w-[calc(100vw-2rem)] gap-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground",
        className,
      )}
    >
      <div className="grid gap-1.5">
        <p className="text-small text-muted-foreground">Your carriers</p>
        <div className="flex items-center gap-2.5 rounded-md bg-accent px-2 py-1.5">
          <Initials name={tenant.name} />
          <span className="min-w-0 flex-1 truncate text-body font-medium">{tenant.name}</span>
          <span className="sr-only">(current)</span>
          <Check aria-hidden className="size-4 shrink-0 text-primary" />
        </div>
        <p className="text-small text-muted-foreground">This login belongs to one carrier</p>
      </div>
      <div className="grid gap-0.5 border-t border-border pt-3 text-body">
        <p className="[overflow-wrap:anywhere]">
          Signed in as <span className="font-medium">{tenant.email}</span>
        </p>
        {/* The zone's everyday name ("Central time"), never its id. The name does not change with the date. */}
        <p className="text-foreground-2">Time zone: {zoneName(tenant.timezone, new Date())}</p>
      </div>
      <div className="border-t border-border pt-3">
        <ThemeToggle />
      </div>
      <div className="border-t border-border pt-2">{signOut}</div>
    </div>
  );
}

// The carrier chip in the top bar. A native <details>, so it opens with a click or Enter without
// any script; the hook below only closes it on Esc and on a click outside.
export function TenantSwitcher({ tenant, signOut }: { tenant: TenantInfo; signOut: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = ref.current;
      if (e.key !== "Escape" || !el?.open) return;
      el.open = false;
      el.querySelector("summary")?.focus();
    }
    function onPointer(e: PointerEvent) {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  return (
    <details ref={ref} className="group relative">
      <summary
        className={cn(
          "flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border border-border bg-card pr-2 pl-1.5",
          "transition-colors duration-150 hover:bg-accent [&::-webkit-details-marker]:hidden",
        )}
      >
        <Initials name={tenant.name} />
        <span className="max-w-[14rem] truncate text-body font-medium max-sm:sr-only">{tenant.name}</span>
        <span className="sr-only">, carrier menu</span>
        <ChevronDown
          aria-hidden
          className="size-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <TenantPanel
        tenant={tenant}
        signOut={signOut}
        className="absolute top-full right-0 z-30 mt-2 shadow-float motion-safe:animate-rise"
      />
    </details>
  );
}
