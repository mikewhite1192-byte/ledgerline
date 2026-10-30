import { CalendarRange } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const quarterReview = {
  group: "Today",
  area: "books",
  order: 30,
  href: "/quarter",
  label: "Quarter review",
  icon: <CalendarRange aria-hidden />,
  shown: () => flags.quarterReviewEnabled === true,
} as const satisfies MenuItem;
