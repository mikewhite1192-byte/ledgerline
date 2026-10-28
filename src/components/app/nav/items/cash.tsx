import { Banknote } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const cash = {
  group: "Money in",
  order: 50,
  href: "/cash",
  label: "Cash",
  icon: <Banknote aria-hidden />,
  shown: () => flags.cashFridayEnabled === true,
} as const satisfies MenuItem;
