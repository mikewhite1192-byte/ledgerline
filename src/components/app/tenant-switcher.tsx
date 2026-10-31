"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useDetailsMenu } from "@/components/ui/details-menu";
import type { Role } from "@/lib/roles";
import { cn } from "@/lib/cn";
import { zoneName } from "@/lib/format/dates";
import { ThemeToggle } from "./theme-toggle";

// role is the membership's, read with the rest. Required: a page that cannot read it fails closed.
export type TenantInfo = {
  name: string;
  email: string;
  timezone: string;
  role: Role;
  // asks:<tenant>:<sub>, where the browser keeps the agent's questions this person closed.
  asksKey?: string;
};

// Two letters for the carrier chip: the first letters of the first two words, else the first two
// letters of the one word.
export function initials(name: string): string {
  const [first, second] = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!first) return "?";
  const pick = second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2);
  return pick.toUpperCase();
}

function Initials({ name, size = "sm", className }: { name: string; size?: "sm" | "md"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-md bg-accent-soft font-semibold text-primary",
        size === "md" ? "size-8 text-small" : "size-6 text-caption",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

// A demo visitor's carrier says so next to its name.
function DemoBadge({ role }: { role: Role }) {
  if (role !== "judge") return null;
  return <span className="shrink-0 rounded-sm bg-secondary px-1.5 text-caption text-foreground-2">Demo</span>;
}

// Who is signed in, the carrier's time zone, the light and dark switch and sign out: the lower half
// of the carrier menu, and the foot of the phone menu, which has no carrier menu of its own.
export function AccountParts({ tenant, signOut }: { tenant: TenantInfo; signOut: ReactNode }) {
  return (
    <>
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
    </>
  );
}

// The carrier at the top of the phone menu: the same tile and name as the sidebar's carrier menu,
// without the menu (the page keeps exactly one carrier menu).
export function CarrierTile({ tenant }: { tenant: TenantInfo }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Initials name={tenant.name} size="md" />
      <span className="min-w-0 truncate text-body font-medium text-foreground">{tenant.name}</span>
      <DemoBadge role={tenant.role} />
    </div>
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
      <AccountParts tenant={tenant} signOut={signOut} />
    </div>
  );
}

// The carrier menu at the top of the sidebar. A native <details>, so it opens with a click or Enter without
// any script; the hook below only closes it on Esc and on a click outside.
export function TenantSwitcher({ tenant, signOut }: { tenant: TenantInfo; signOut: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useDetailsMenu(ref);

  return (
    <details ref={ref} className="group relative">
      <summary
        className={cn(
          "flex h-12 w-full cursor-pointer list-none items-center gap-2.5 rounded-lg px-2",
          "transition-colors duration-150 hover:bg-accent group-open:bg-accent [&::-webkit-details-marker]:hidden",
        )}
      >
        <Initials name={tenant.name} size="md" />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">{tenant.name}</span>
        <DemoBadge role={tenant.role} />
        <span className="sr-only">, carrier menu</span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <TenantPanel
        tenant={tenant}
        signOut={signOut}
        className="absolute top-full left-0 z-30 mt-1 shadow-float motion-safe:animate-rise"
      />
    </details>
  );
}
