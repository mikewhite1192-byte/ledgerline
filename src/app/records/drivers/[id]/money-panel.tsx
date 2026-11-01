"use client";

import { useRouter } from "next/navigation";
import { DriverMoneyPanel } from "@/components/app/driver-money-panel";
import type { DriverIdentity } from "@/lib/advances/identity";

// The driver page's money panel, reading the page again after every press.
// statusAdminOn and today come from the server (the driver admin switch and the carrier's date).
export function DriverMoney({
  identity,
  canAdmin,
  timezone,
  statusAdminOn,
  today,
}: {
  identity: DriverIdentity;
  canAdmin: boolean;
  timezone: string;
  statusAdminOn: boolean;
  today: string;
}) {
  const router = useRouter();
  return (
    <DriverMoneyPanel
      identity={identity}
      canAdmin={canAdmin}
      timezone={timezone}
      statusAdminOn={statusAdminOn}
      today={today}
      onDone={() => router.refresh()}
    />
  );
}
