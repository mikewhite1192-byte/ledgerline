import { Banknote } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const settlements = {
  group: "Pay",
  area: "pay",
  order: 15,
  href: "/settlements",
  label: "Pay",
  icon: <Banknote aria-hidden />,
  shown: () => flags.settlementsEnabled === true,
  section: "pay",
  sectionOrder: 10,
  sectionLabel: "Paystubs",
} as const satisfies MenuItem;
