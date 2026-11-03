import type { ReactNode } from "react";

// The menu's groups, in the order they show. A group is the job the office is doing; a group with
// no item shown prints nothing, so "Records" waits here for its first item.
export const MENU_GROUPS = ["Today", "Pay", "Money in", "Drivers", "Records", "Settings"] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

// The three areas the sidebar's tabs switch between, in the order the tabs show, with their names.
// An area holds whole groups or parts of them; the groups keep their headers inside it.
export const MENU_AREAS = ["pay", "billing", "books"] as const;
export type MenuArea = (typeof MENU_AREAS)[number];
export const AREA_LABELS: Readonly<Record<MenuArea, string>> = { pay: "Pay", billing: "Billing", books: "Books" };

// The simple shape's five words (flags.simpleShape), in the order they show, with their names. Each
// is one row in the menu; the open one lists its pages under it.
export const MENU_SECTIONS = ["home", "pay", "billing", "drivers", "settings"] as const;
export type MenuSection = (typeof MENU_SECTIONS)[number];
export const SECTION_LABELS: Readonly<Record<MenuSection, string>> = {
  home: "Home",
  pay: "Pay",
  billing: "Billing",
  drivers: "Drivers",
  settings: "Settings",
};

// One menu item, defined in its own file under ./items. `order` places it within its group, spaced
// by ten so a new item fits between two without renumbering. `area` is the tab it shows under;
// "primary" sits above the tabs on every page (Home). `shown` is read on every render, so an item
// behind a switch shows only while its switch is on.
//
// Under the simple shape: `section` is the one of the five words it sits under, and `sectionOrder`
// places it there (0 is the section's own page, the row itself, never listed under it; the first
// listed page opens the section when it has no page of its own). `sectionLabel` is the page's name
// under the simple shape where it differs from `label`.
export type MenuItem = {
  group: MenuGroup;
  area: MenuArea | "primary";
  order: number;
  href: string;
  label: string;
  icon: ReactNode;
  shown: () => boolean;
  section: MenuSection;
  sectionOrder: number;
  sectionLabel?: string;
};
