import { Banknote } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const cash = {
  group: "Money in",
  area: "billing",
  order: 50,
  href: "/cash",
  label: "Cash",
  icon: <Banknote aria-hidden />,
  shown: () => flags.cashFridayEnabled === true,
  section: "pay",
  sectionOrder: 70,
  sectionLabel: "Friday's cash",
} as const satisfies MenuItem;
