import { Wallet } from "lucide-react";
import { flags } from "@/config/flags";
import type { MenuItem } from "../menu-item";

export const customerPayments = {
  group: "Money in",
  area: "billing",
  order: 20,
  href: "/customer-payments/new",
  label: "Payments",
  icon: <Wallet aria-hidden />,
  shown: () => flags.customerPaymentsEnabled === true,
} as const satisfies MenuItem;
