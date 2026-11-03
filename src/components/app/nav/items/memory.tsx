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
  section: "settings",
  sectionOrder: 50,
} as const satisfies MenuItem;
