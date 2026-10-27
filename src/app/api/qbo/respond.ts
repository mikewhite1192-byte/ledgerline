import { NextResponse } from "next/server";
import type { ConnectRefusal, TenantRun } from "@/lib/adapters/accounting/qbo/connect";
import type { Session } from "@/lib/auth/claims";
import { withSessionTenant } from "@/lib/tenant/context";

// What the QuickBooks routes share. Every answer goes back to the settings page with one word in
// the query, never Intuit's text; the Location is relative, so it never depends on how the host
// reports its own URL.

export const SETTINGS_PATH = "/settings/accounting";

export type SettingsNote = ConnectRefusal | "connected" | "disconnected";

export function toSettings(note: SettingsNote): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${SETTINGS_PATH}?qbo=${note}` },
  });
}

export function tenantRun(session: Session): TenantRun {
  return (fn) => withSessionTenant(session, fn);
}
