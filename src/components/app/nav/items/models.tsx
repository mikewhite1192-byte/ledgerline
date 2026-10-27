import { Cpu } from "lucide-react";
import type { MenuItem } from "../menu-item";

export const models = {
  group: "Settings",
  order: 20,
  href: "/models",
  label: "Models and spend",
  icon: <Cpu aria-hidden />,
  shown: () => true,
} as const satisfies MenuItem;
