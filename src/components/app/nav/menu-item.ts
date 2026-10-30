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

// One menu item, defined in its own file under ./items. `order` places it within its group, spaced
// by ten so a new item fits between two without renumbering. `area` is the tab it shows under;
// "primary" sits above the tabs on every page (Home). `shown` is read on every render, so an item
// behind a switch shows only while its switch is on.
export type MenuItem = {
  group: MenuGroup;
  area: MenuArea | "primary";
  order: number;
  href: string;
  label: string;
  icon: ReactNode;
  shown: () => boolean;
};
