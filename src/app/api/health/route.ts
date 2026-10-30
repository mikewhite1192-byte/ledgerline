import { NextResponse } from "next/server";
import { flags } from "@/config/flags";

// Deploy check: the commit this build came from, so a deploy can be confirmed by version, and
// which features a visitor can use right now (booleans from the release switches, no secrets),
// so the deployed demo-path test skips a step that is not released instead of failing it.
export const dynamic = "force-dynamic";

export function GET() {
  const agent = flags.agentEnabled && flags.aiEnabled;
  return NextResponse.json({
    ok: true,
    version: process.env.APP_COMMIT ?? "local",
    features: {
      agent,
      auditor: agent && flags.auditorEnabled,
      reports: agent && flags.reportsEnabled,
      driverNotes: flags.driverNotesEnabled,
      advances: flags.advancesEnabled,
      payouts: flags.payoutsEnabled,
      accounting: flags.accountingEnabled,
      // The demo carrier's visitor sign-in, and the demo reset.
      judgeAccess: flags.judgeAccess.enabled,
      demoReset: flags.demoResetEnabled,
    },
  });
}
