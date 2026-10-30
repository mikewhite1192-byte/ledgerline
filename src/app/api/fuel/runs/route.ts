import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readTenant } from "@/lib/data/read";
import { runFuelCheck } from "@/lib/fuel/run";
import { isCrossSite } from "@/lib/http/same-site";
import { demoCarrierFor } from "@/lib/seed/carriers";
import { withSessionTenant } from "@/lib/tenant/context";
import { failed, refused, reply } from "../reply";

// POST: "Check this week's fuel". Runs the four fuel checks over the carrier's records, writes the
// findings, compares receipt photos for a fill-up turned in twice, and answers the counts. It only
// lists; nothing here drafts a card, approves or pays.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again inside runFuelCheck and the compare.
  if (!flags.fuelAnomalyEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  try {
    // The checks list fill-ups from one shared start date, the first day of the seeded demo weeks,
    // so they run for the demo carriers only: any other carrier is refused as if the switch were
    // off, before any work.
    const demo = await withSessionTenant(session, async (q) => demoCarrierFor(await readTenant(q)));
    if (!demo) return refused("disabled");
    const run = await runFuelCheck(session);
    if (!run.ok) return refused(run.category);
    return reply({ checked: run.checked, needYou: run.needYou }, 200);
  } catch (err) {
    return failed("fuel run", err);
  }
}
