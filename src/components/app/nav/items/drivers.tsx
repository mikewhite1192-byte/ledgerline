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
} as const satisfies MenuItem;
