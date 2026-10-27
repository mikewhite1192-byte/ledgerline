import { RotateCcw } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const demo = {
  group: "Settings",
  order: 40,
  href: "/settings/demo",
  label: "Demo",
  icon: <RotateCcw aria-hidden />,
  shown: () => flags.demoResetEnabled === true,
} as const satisfies MenuItem;
