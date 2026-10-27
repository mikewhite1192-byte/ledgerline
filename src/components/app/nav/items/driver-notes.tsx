import { NotebookPen } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const driverNotes = {
  group: "Pay",
  order: 20,
  href: "/driver-notes",
  label: "Driver notes",
  icon: <NotebookPen aria-hidden />,
  shown: () => flags.driverNotesEnabled === true,
} as const satisfies MenuItem;
