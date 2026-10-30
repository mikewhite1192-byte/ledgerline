import { Banknote } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const settlements = {
  group: "Pay",
  area: "pay",
  order: 15,
  href: "/settlements",
  label: "Settlements",
  icon: <Banknote aria-hidden />,
  shown: () => flags.settlementsEnabled === true,
} as const satisfies MenuItem;
