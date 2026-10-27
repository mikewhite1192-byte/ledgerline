import { AudioLines, Cpu, FileText, Globe, HandCoins, House, NotebookPen, Video, Wallet } from "lucide-react";
import { flags } from "@/config/flags";
import type { NavItem } from "./nav-list";

// The signed-in sidebar, one list for every page so they cannot drift apart. An item behind a
// switch shows only while its switch is on, so a dark feature has no way in from the menu; its
// page still says it is off if someone types the address.
const ITEMS = [
  { href: "/", label: "Home", icon: <House aria-hidden />, shown: () => true },
  { href: "/documents", label: "Documents", icon: <FileText aria-hidden />, shown: () => flags.documentsEnabled === true },
  { href: "/advances", label: "Advances", icon: <HandCoins aria-hidden />, shown: () => flags.advancesEnabled === true },
  { href: "/driver-notes", label: "Driver notes", icon: <NotebookPen aria-hidden />, shown: () => flags.driverNotesEnabled === true },
  { href: "/invoices", label: "Invoices", icon: <FileText aria-hidden />, shown: () => flags.invoicesEnabled === true },
  {
    href: "/customer-payments/new",
    label: "Payments",
    icon: <Wallet aria-hidden />,
    shown: () => flags.customerPaymentsEnabled === true,
  },
  { href: "/voice-notes", label: "Voice notes", icon: <AudioLines aria-hidden />, shown: () => flags.voiceIntakeEnabled === true },
  { href: "/clips", label: "Dock clips", icon: <Video aria-hidden />, shown: () => flags.clipsEnabled === true },
  { href: "/models", label: "Meta models", icon: <Cpu aria-hidden />, shown: () => true },
  { href: "/portal-runs", label: "Portal runs", icon: <Globe aria-hidden />, shown: () => flags.portalRunnerEnabled === true },
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
