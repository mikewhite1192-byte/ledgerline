import { Cpu, House } from "lucide-react";
import type { NavItem } from "./nav-list";

// The signed-in pages' navigation, one list for every page so they cannot drift apart.
const ITEMS = [
  { href: "/", label: "Home", icon: <House aria-hidden /> },
  { href: "/models", label: "Meta models", icon: <Cpu aria-hidden /> },
] as const;

export function appNav(current: string): NavItem[] {
  return ITEMS.map((item) => ({ ...item, current: item.href === current }));
}
