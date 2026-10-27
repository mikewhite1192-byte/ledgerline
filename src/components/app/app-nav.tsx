import {
  AudioLines,
  BookOpen,
  Cpu,
  FileText,
  Globe,
  HandCoins,
  House,
  NotebookPen,
  ScanSearch,
  Video,
  Wallet,
} from "lucide-react";
import { flags } from "@/config/flags";
import type { NavItem } from "./nav-list";

// The signed-in menu, one list for the sidebar and the phone sheet so they cannot drift apart,
// grouped by the job the office is doing. An item behind a switch shows only while its switch is
// on, so a dark feature has no way in from the menu; its page still says it is off if someone types
// the address. A group with every item hidden is not shown at all.
const ITEMS = [
  { group: "Today", href: "/", label: "Home", icon: <House aria-hidden />, shown: () => true },
  { group: "Pay", href: "/sweep", label: "Sweep", icon: <ScanSearch aria-hidden />, shown: () => flags.sweepEnabled === true },
  {
    group: "Pay",
    href: "/driver-notes",
    label: "Driver notes",
    icon: <NotebookPen aria-hidden />,
    shown: () => flags.driverNotesEnabled === true,
  },
  { group: "Pay", href: "/advances", label: "Advances", icon: <HandCoins aria-hidden />, shown: () => flags.advancesEnabled === true },
  {
    group: "Money in",
    href: "/invoices",
    label: "Invoices",
    icon: <FileText aria-hidden />,
    shown: () => flags.invoicesEnabled === true,
  },
  {
    group: "Money in",
    href: "/customer-payments/new",
    label: "Payments",
    icon: <Wallet aria-hidden />,
    shown: () => flags.customerPaymentsEnabled === true,
  },
  {
    group: "Drivers",
    href: "/documents",
    label: "Documents",
    icon: <FileText aria-hidden />,
    shown: () => flags.documentsEnabled === true,
  },
  {
    group: "Drivers",
    href: "/voice-notes",
    label: "Voice notes",
    icon: <AudioLines aria-hidden />,
    shown: () => flags.voiceIntakeEnabled === true,
  },
  { group: "Drivers", href: "/clips", label: "Dock clips", icon: <Video aria-hidden />, shown: () => flags.clipsEnabled === true },
  {
    group: "Settings",
    href: "/settings/accounting",
    label: "QuickBooks",
    icon: <BookOpen aria-hidden />,
    shown: () => flags.accountingEnabled === true,
  },
  { group: "Settings", href: "/models", label: "Models and spend", icon: <Cpu aria-hidden />, shown: () => true },
  {
    group: "Settings",
    href: "/portal-runs",
    label: "Portal runs",
    icon: <Globe aria-hidden />,
    shown: () => flags.portalRunnerEnabled === true,
  },
] as const;

// Where a page sits in the nav: its item's address, or "none" for a record page with no item.
export type NavKey = (typeof ITEMS)[number]["href"] | "none";

// Every address the menu can link to, shown or not (the route test walks the app against it).
export const NAV_HREFS: readonly string[] = ITEMS.map((item) => item.href);

export function appNav(current: NavKey): NavItem[] {
  return ITEMS.filter((item) => item.shown()).map(({ group, href, label, icon }) => ({
    group,
    href,
    label,
    icon,
    current: href === current,
  }));
}
