import { FileText } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const documents = {
  group: "Drivers",
  order: 10,
  href: "/documents",
  label: "Documents",
  icon: <FileText aria-hidden />,
  shown: () => flags.documentsEnabled === true,
} as const satisfies MenuItem;
