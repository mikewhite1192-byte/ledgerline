import { House } from "lucide-react";
import type { MenuItem } from "../menu-item";

export const home = {
  group: "Today",
  area: "primary",
  order: 10,
  href: "/",
  label: "Home",
  icon: <House aria-hidden />,
  shown: () => true,
} as const satisfies MenuItem;
