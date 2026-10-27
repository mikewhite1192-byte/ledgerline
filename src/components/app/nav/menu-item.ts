import type { ReactNode } from "react";

// The menu's groups, in the order they show. A group is the job the office is doing; a group with
// no item shown prints nothing, so "Records" waits here for its first item.
export const MENU_GROUPS = ["Today", "Pay", "Money in", "Drivers", "Records", "Settings"] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

// One menu item, defined in its own file under ./items. `order` places it within its group, spaced
// by ten so a new item fits between two without renumbering. `shown` is read on every render, so
// an item behind a switch shows only while its switch is on.
export type MenuItem = {
  group: MenuGroup;
  order: number;
  href: string;
  label: string;
  icon: ReactNode;
  shown: () => boolean;
};
