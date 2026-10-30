import { BellRing } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const collections = {
  group: "Money in",
  area: "billing",
  order: 40,
  href: "/collections",
  label: "Collections",
  icon: <BellRing aria-hidden />,
  shown: () => flags.collectionsEnabled === true,
} as const satisfies MenuItem;
