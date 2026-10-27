import { Globe } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const portalRuns = {
  group: "Settings",
  order: 30,
  href: "/portal-runs",
  label: "Portal runs",
  icon: <Globe aria-hidden />,
  shown: () => flags.portalRunnerEnabled === true,
} as const satisfies MenuItem;
