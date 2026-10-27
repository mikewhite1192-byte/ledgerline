import { Video } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const clips = {
  group: "Drivers",
  order: 30,
  href: "/clips",
  label: "Dock clips",
  icon: <Video aria-hidden />,
  shown: () => flags.clipsEnabled === true,
} as const satisfies MenuItem;
