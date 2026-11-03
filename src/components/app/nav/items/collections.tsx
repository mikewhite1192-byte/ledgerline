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
  section: "billing",
  sectionOrder: 20,
} as const satisfies MenuItem;
