import Link from "next/link";
import { cn } from "@/lib/cn";
import { AREA_LABELS, type MenuArea } from "./nav/menu-item";

export type AreaTab = { area: MenuArea; href: string };

// The sidebar's three areas as one segmented row. Each is a plain link to the area's first page,
// so the open area always follows the page in the address bar and there is no state to keep; the
// one for the page you are on is marked current.
export function AreaTabs({ tabs, current }: { tabs: AreaTab[]; current: MenuArea }) {
  return (
    <ul
      aria-label="Areas"
      className="grid gap-1 rounded-lg bg-secondary p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((t) => {
        const on = t.area === current;
        return (
          <li key={t.area} className="min-w-0">
            <Link
              href={t.href}
              aria-current={on ? "true" : undefined}
              className={cn(
                "flex h-8 items-center justify-center truncate rounded-md px-2 text-small font-medium transition-colors duration-150",
                on ? "bg-card text-foreground ring-1 ring-border" : "text-foreground-2 hover:text-foreground",
              )}
            >
              {AREA_LABELS[t.area]}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
