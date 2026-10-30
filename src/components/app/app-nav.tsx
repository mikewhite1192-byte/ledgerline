import * as registry from "./nav/items";
import { MENU_GROUPS, type MenuItem } from "./nav/menu-item";
import type { NavItem } from "./nav-list";

// The signed-in menu, one list for the sidebar and the phone sheet so they cannot drift apart,
// grouped by the job the office is doing. Each item is its own file under ./nav/items, listed once
// in that folder's index. The menu places items by their group's place in MENU_GROUPS, then by
// their own `order`, so a line's position in the index never moves an item. An item behind a
// switch shows only while its switch is on, so a dark feature has no way in from the menu; its
// page still says it is off if someone types the address. A group with every item hidden is not
// shown at all.
const ITEMS: readonly MenuItem[] = Object.values(registry).sort(
  (a, b) => MENU_GROUPS.indexOf(a.group) - MENU_GROUPS.indexOf(b.group) || a.order - b.order,
);

// Where a page sits in the nav: its item's address, or "none" for a record page with no item.
export type NavKey = (typeof registry)[keyof typeof registry]["href"] | "none";

// Every address the menu can link to, shown or not (the route test walks the app against it).
export const NAV_HREFS: readonly string[] = ITEMS.map((item) => item.href);

export function appNav(current: NavKey): NavItem[] {
  return ITEMS.filter((item) => item.shown()).map(({ group, area, href, label, icon }) => ({
    group,
    area,
    href,
    label,
    icon,
    current: href === current,
  }));
}
