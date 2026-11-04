import { Truck } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const road = {
  group: "Today",
  area: "pay",
  order: 17,
  href: "/road",
  label: "On the road",
  icon: <Truck aria-hidden />,
  shown: () => flags.journey.enabled === true,
  section: "home",
  sectionOrder: 20,
} as const satisfies MenuItem;
