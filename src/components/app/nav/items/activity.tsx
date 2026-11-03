import { Activity } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const activity = {
  group: "Today",
  area: "pay",
  order: 15,
  href: "/activity",
  label: "Live feed",
  icon: <Activity aria-hidden />,
  shown: () => flags.activityFeed.enabled === true,
} as const satisfies MenuItem;
