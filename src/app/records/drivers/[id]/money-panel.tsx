"use client";

import { useRouter } from "next/navigation";
import { DriverMoneyPanel } from "@/components/app/driver-money-panel";
import type { ActivationChecklist } from "@/lib/advances/activation";
import type { DriverIdentity } from "@/lib/advances/identity";

// The driver page's money panel, reading the page again after every press.
// statusAdminOn and today come from the server (the driver admin switch and the carrier's date), and
// so does activation (the checklist while its switch is on and the driver is not armed, else null).
export function DriverMoney({
  identity,
  canAdmin,
  timezone,
  statusAdminOn,
  today,
  activation,
}: {
  identity: DriverIdentity;
  canAdmin: boolean;
  timezone: string;
  statusAdminOn: boolean;
  today: string;
  activation: ActivationChecklist | null;
}) {
  const router = useRouter();
  return (
    <DriverMoneyPanel
      identity={identity}
      canAdmin={canAdmin}
      timezone={timezone}
      statusAdminOn={statusAdminOn}
      today={today}
      activation={activation}
      onDone={() => router.refresh()}
    />
  );
}
