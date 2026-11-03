import { Users } from "lucide-react";
import type { MenuItem } from "../menu-item";

export const drivers = {
  group: "Drivers",
  area: "pay",
  order: 5,
  href: "/drivers",
  label: "Drivers",
  icon: <Users aria-hidden />,
  shown: () => true,
  section: "drivers",
  sectionOrder: 10,
} as const satisfies MenuItem;
