import { Cpu, House, NotebookPen, Video } from "lucide-react";
import { flags } from "@/config/flags";
import type { NavItem } from "./nav-list";

// The signed-in pages' navigation, one list for every page so they cannot drift apart. A page
// section appears only while its switch is on.
export function appNav(current: string): NavItem[] {
  const items: NavItem[] = [
    { href: "/", label: "Home", icon: <House aria-hidden /> },
    ...(flags.driverNotesEnabled
      ? [{ href: "/driver-notes", label: "Driver notes", icon: <NotebookPen aria-hidden /> }]
      : []),
    ...(flags.clipsEnabled
      ? [{ href: "/clips", label: "Dock clips", icon: <Video aria-hidden /> }]
      : []),
    { href: "/models", label: "Meta models", icon: <Cpu aria-hidden /> },
  ];
  return items.map((item) => ({ ...item, current: item.href === current }));
}
