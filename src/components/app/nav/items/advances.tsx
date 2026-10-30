import { HandCoins } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const advances = {
  group: "Pay",
  area: "pay",
  order: 30,
  href: "/advances",
  label: "Advances",
  icon: <HandCoins aria-hidden />,
  shown: () => flags.advancesEnabled === true,
} as const satisfies MenuItem;
