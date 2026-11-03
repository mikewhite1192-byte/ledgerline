import { ScanSearch } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const sweep = {
  group: "Pay",
  area: "pay",
  order: 10,
  href: "/sweep",
  label: "Pay sweep",
  icon: <ScanSearch aria-hidden />,
  shown: () => flags.sweepEnabled === true,
  section: "pay",
  sectionOrder: 20,
  sectionLabel: "Pay check",
} as const satisfies MenuItem;
