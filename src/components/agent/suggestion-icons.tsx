import {
  Banknote,
  CalendarCheck,
  ChartColumn,
  ClipboardCheck,
  FileText,
  HandCoins,
  Hourglass,
  Mail,
  MessageCircle,
  SlidersHorizontal,
  Timer,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";

// Each suggested question's icon, looked up by its id here in the browser: a suggestion crosses from
// the server as plain data, so it never carries a component. An id not listed gets the speech bubble.
const ICONS: Readonly<Record<string, LucideIcon>> = {
  "paystub-problems": ClipboardCheck,
  "past-60": Hourglass,
  "pay-run-cost": Banknote,
  "make-pay-run": Wallet,
  "advance-limit": HandCoins,
  "margin-per-load": TrendingUp,
  "profit-brief": ChartColumn,
  "quarter-review": CalendarCheck,
  "payment-reminder": Mail,
  "unbilled-detention": Timer,
  "change-pay-rule": SlidersHorizontal,
  "explain-paystub": FileText,
};

export const FALLBACK_ICON: LucideIcon = MessageCircle;

export function suggestionIcon(id: string): LucideIcon {
  return Object.hasOwn(ICONS, id) ? ICONS[id] : FALLBACK_ICON;
}
