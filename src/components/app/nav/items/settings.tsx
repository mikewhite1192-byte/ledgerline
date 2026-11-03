import { Settings } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

// The Settings landing page (/settings), the simple shape's fifth word. It is the section's own
// page, so it is the row itself; under the old menu (the switch off) it is not listed and the
// settings pages keep their own rows.
export const settings = {
  group: "Settings",
  area: "books",
  order: 5,
  href: "/settings",
  label: "Settings",
  icon: <Settings aria-hidden />,
  shown: () => flags.simpleShape.enabled === true,
  section: "settings",
  sectionOrder: 0,
} as const satisfies MenuItem;
