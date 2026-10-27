import { BookOpen } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const accounting = {
  group: "Settings",
  order: 10,
  href: "/settings/accounting",
  label: "QuickBooks",
  icon: <BookOpen aria-hidden />,
  shown: () => flags.accountingEnabled === true,
} as const satisfies MenuItem;
