import { Ticket } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const moneyCodes = {
  group: "Pay",
  order: 35,
  href: "/money-codes",
  label: "Money codes",
  icon: <Ticket aria-hidden />,
  shown: () => flags.moneyCodes.enabled === true,
} as const satisfies MenuItem;
