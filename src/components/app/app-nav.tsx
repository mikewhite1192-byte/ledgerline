import { Cpu, HandCoins, House, NotebookPen } from "lucide-react";
import { flags } from "@/config/flags";
import type { NavItem } from "./nav-list";

// The signed-in sidebar, one list for every page so they cannot drift apart. An item behind a
// switch shows only while its switch is on, so a dark feature has no way in from the menu.
const ITEMS = [
  { href: "/", label: "Home", icon: <House aria-hidden />, shown: () => true },
  { href: "/advances", label: "Advances", icon: <HandCoins aria-hidden />, shown: () => flags.advancesEnabled === true },
  { href: "/driver-notes", label: "Driver notes", icon: <NotebookPen aria-hidden />, shown: () => flags.driverNotesEnabled === true },
  { href: "/models", label: "Meta models", icon: <Cpu aria-hidden />, shown: () => true },
] as const;

export function appNav(current: string): NavItem[] {
  return ITEMS.filter((item) => item.shown()).map(({ href, label, icon }) => ({
    href,
    label,
    icon,
    current: href === current,
  }));
}
