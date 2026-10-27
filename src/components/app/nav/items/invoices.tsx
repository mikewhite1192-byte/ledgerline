import { FileText } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const invoices = {
  group: "Money in",
  order: 10,
  href: "/invoices",
  label: "Invoices",
  icon: <FileText aria-hidden />,
  shown: () => flags.invoicesEnabled === true,
} as const satisfies MenuItem;
