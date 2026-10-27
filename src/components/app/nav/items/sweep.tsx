import { ScanSearch } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const sweep = {
  group: "Pay",
  order: 10,
  href: "/sweep",
  label: "Sweep",
  icon: <ScanSearch aria-hidden />,
  shown: () => flags.sweepEnabled === true,
} as const satisfies MenuItem;
