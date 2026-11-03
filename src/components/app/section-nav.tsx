import { Banknote, FileText, House, Settings, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { MENU_SECTIONS, SECTION_LABELS, type MenuSection } from "./nav/menu-item";
import { navRowClass, type NavItem } from "./nav-list";

const SECTION_ICONS: Readonly<Record<MenuSection, ReactNode>> = {
  home: <House aria-hidden />,
  pay: <Banknote aria-hidden />,
  billing: <FileText aria-hidden />,
  drivers: <Users aria-hidden />,
  settings: <Settings aria-hidden />,
};

export type SectionRow = {
  section: MenuSection;
  label: string;
  href: string;
  // The row's own page is the page you are on.
  current: boolean;
  // The current page sits in this section, so its pages show under it.
  open: boolean;
  pages: { href: string; label: string; current: boolean }[];
};

// The five rows from the shown items. A section with no shown item is left out. A section's row
// opens its own page (sectionOrder 0) when it has one, else its first listed page. Home lists no
// pages under it: the live feed is reached from Home's "See everything". A page with no item of its
// own (a record page) opens no section.
export function sectionRows(nav: NavItem[]): SectionRow[] {
  const here = nav.find((i) => i.current);
  return MENU_SECTIONS.flatMap((section) => {
    const items = nav
      .filter((i) => i.section === section)
      .sort((a, b) => (a.sectionOrder ?? 0) - (b.sectionOrder ?? 0));
    if (items.length === 0) return [];
    const own = items.find((i) => i.sectionOrder === 0);
    const listed = section === "home" ? [] : items.filter((i) => i !== own);
    const href = (own ?? listed[0] ?? items[0]).href;
    return [
      {
        section,
        label: SECTION_LABELS[section],
        href,
        current: own !== undefined && own.current === true,
        open: here?.section === section,
        pages: listed.map((i) => ({ href: i.href, label: i.sectionLabel ?? i.label, current: i.current === true })),
      },
    ];
  });
}

// The simple shape's menu (flags.simpleShape), for the sidebar and the phone sheet: five rows, the
// current page's row open with its pages under it, indented and quiet; the others closed. Each row
// is a plain link, so the open row always follows the page in the address bar.
export function SectionNav({ nav }: { nav: NavItem[] }) {
  const rows = sectionRows(nav);
  return (
    <ul aria-label="Sections" className="grid grid-cols-1 gap-0.5">
      {rows.map((row) => (
        <li key={row.section} className="grid grid-cols-1 gap-0.5">
          <Link
            href={row.href}
            aria-current={row.current ? "page" : undefined}
            className={cn(navRowClass(row.current), row.open && !row.current && "font-medium text-foreground")}
          >
            {SECTION_ICONS[row.section]}
            {row.label}
          </Link>
          {row.open && row.pages.length > 0 ? (
            <ul aria-label={row.label} className="grid grid-cols-1 gap-0.5 pb-1 pl-7">
              {row.pages.map((page) => (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    aria-current={page.current ? "page" : undefined}
                    className={cn(
                      "block h-8 truncate rounded-md px-2.5 text-small leading-8 transition-colors duration-150",
                      page.current
                        ? "bg-accent-soft font-medium text-foreground"
                        : "text-foreground-2 hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {page.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
