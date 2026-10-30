import { Fuel } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const rates = {
  group: "Settings",
  area: "books",
  order: 45,
  href: "/settings/rates",
  label: "Fuel and tax rates",
  icon: <Fuel aria-hidden />,
  shown: () => flags.groundedRatesEnabled === true,
} as const satisfies MenuItem;
