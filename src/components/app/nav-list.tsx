import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// `group` is the job the item belongs to ("Pay", "Money in"). Items of one group sit together.
export type NavItem = { href: string; label: string; icon: ReactNode; current?: boolean; group?: string };

// Consecutive items with the same group become one run; an item with no group is a run of its own
// kind, so a flat list (the /design specimen) renders as before.
function runs(items: NavItem[]): { group?: string; items: NavItem[] }[] {
  const out: { group?: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.group === item.group) last.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
}

function Items({ items, label }: { items: NavItem[]; label?: string }) {
  return (
    <ul aria-label={label} className="grid gap-0.5">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            aria-current={item.current ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-body transition-colors duration-150 [&_svg]:size-4 [&_svg]:shrink-0",
              item.current
                ? "bg-accent font-medium text-foreground [&_svg]:text-primary"
                : "text-foreground-2 hover:bg-accent hover:text-foreground [&_svg]:text-muted-foreground",
            )}
          >
            {item.icon}
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

// A group's header is plain text, never a link. A group with no items is never passed in, so it
// never prints a header. The list's own name carries the group for a screen reader, so the visible
// header is hidden from it rather than read twice.
export function NavList({ items }: { items: NavItem[] }) {
  const groups = runs(items);
  if (groups.every((g) => g.group === undefined)) return <Items items={items} />;
  return (
    <div className="grid gap-4">
      {groups.map((g, i) =>
        g.group === undefined ? (
          <Items key={`run-${i}`} items={g.items} />
        ) : (
          <div key={`${g.group}-${i}`} className="grid gap-1">
            <p aria-hidden className="px-2.5 text-caption font-medium tracking-wide text-muted-foreground uppercase">
              {g.group}
            </p>
            <Items items={g.items} label={g.group} />
          </div>
        ),
      )}
    </div>
  );
}
