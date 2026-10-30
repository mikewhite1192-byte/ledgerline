import { Brain } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const memory = {
  group: "Settings",
  area: "books",
  order: 50,
  href: "/memory",
  label: "Memory",
  icon: <Brain aria-hidden />,
  shown: () => flags.carrierMemoryEnabled === true,
} as const satisfies MenuItem;
