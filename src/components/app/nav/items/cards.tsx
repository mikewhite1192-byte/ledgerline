import { CreditCard } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const cards = {
  group: "Pay",
  area: "pay",
  order: 45,
  href: "/cards",
  label: "Card check",
  icon: <CreditCard aria-hidden />,
  shown: () => flags.cardRecon.enabled === true,
} as const satisfies MenuItem;
