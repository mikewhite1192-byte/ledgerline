"use client";

import { useRouter } from "next/navigation";
import { DriverMoneyPanel } from "@/components/app/driver-money-panel";
import type { DriverIdentity } from "@/lib/advances/identity";

// The driver page's money panel, reading the page again after every press.
export function DriverMoney({ identity, canAdmin, timezone }: { identity: DriverIdentity; canAdmin: boolean; timezone: string }) {
  const router = useRouter();
  return <DriverMoneyPanel identity={identity} canAdmin={canAdmin} timezone={timezone} onDone={() => router.refresh()} />;
}
