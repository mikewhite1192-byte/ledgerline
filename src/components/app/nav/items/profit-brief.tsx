import { TrendingUp } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const profitBrief = {
  group: "Today",
  area: "books",
  order: 20,
  href: "/profit",
  label: "Profit brief",
  icon: <TrendingUp aria-hidden />,
  shown: () => flags.profitBriefEnabled === true,
} as const satisfies MenuItem;
