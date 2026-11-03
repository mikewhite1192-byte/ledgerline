import { AudioLines } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const voiceNotes = {
  group: "Drivers",
  area: "pay",
  order: 20,
  href: "/voice-notes",
  label: "Voice notes",
  icon: <AudioLines aria-hidden />,
  shown: () => flags.voiceIntakeEnabled === true,
  section: "drivers",
  sectionOrder: 30,
} as const satisfies MenuItem;
