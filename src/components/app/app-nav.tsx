import { Cpu, FileText, House, NotebookPen, Wallet } from "lucide-react";
import { flags } from "@/config/flags";
import type { NavItem } from "./nav-list";

// The signed-in pages' navigation, one list for every page so they cannot drift apart. A screen
// whose switch is off stays out of the list; its page still says it is off if someone types the
// address.
const ITEMS = [
  { href: "/", label: "Home", icon: <House aria-hidden />, shown: () => true },
  {
    href: "/driver-notes",
    label: "Driver notes",
    icon: <NotebookPen aria-hidden />,
    shown: () => flags.driverNotesEnabled,
  },
  { href: "/invoices", label: "Invoices", icon: <FileText aria-hidden />, shown: () => flags.invoicesEnabled },
  {
    href: "/customer-payments/new",
    label: "Payments",
    icon: <Wallet aria-hidden />,
    shown: () => flags.customerPaymentsEnabled,
  },
  { href: "/models", label: "Meta models", icon: <Cpu aria-hidden />, shown: () => true },
] as const;

// Where a page sits in the nav: its item's address, or "none" for a record page with no item.
export type NavKey = (typeof ITEMS)[number]["href"] | "none";

export function appNav(current: NavKey): NavItem[] {
  return ITEMS.filter((item) => item.shown()).map(({ href, label, icon }) => ({
    href,
    label,
    icon,
    current: href === current,
  }));
}
