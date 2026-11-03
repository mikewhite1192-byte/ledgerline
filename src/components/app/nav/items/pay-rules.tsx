import { SlidersHorizontal } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const payRules = {
  group: "Settings",
  area: "books",
  order: 15,
  href: "/settings/pay-rules",
  label: "Pay rules",
  icon: <SlidersHorizontal aria-hidden />,
  shown: () => flags.rulesByTalkingEnabled === true,
  section: "settings",
  sectionOrder: 10,
} as const satisfies MenuItem;
