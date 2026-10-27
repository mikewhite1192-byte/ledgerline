import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type NavItem = { href: string; label: string; icon: ReactNode; current?: boolean };

export function NavList({ items }: { items: NavItem[] }) {
  return (
    <ul className="grid gap-0.5">
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
