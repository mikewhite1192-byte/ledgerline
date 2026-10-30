import { FileStack } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const factoring = {
  group: "Money in",
  order: 60,
  href: "/factoring",
  label: "Factoring",
  icon: <FileStack aria-hidden />,
  shown: () => flags.factoring?.enabled === true,
} as const satisfies MenuItem;
