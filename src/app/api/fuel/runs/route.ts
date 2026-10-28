import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { runFuelCheck } from "@/lib/fuel/run";
import { isCrossSite } from "@/lib/http/same-site";
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
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  try {
    const run = await runFuelCheck(session);
    if (!run.ok) return refused(run.category);
    return reply({ checked: run.checked, needYou: run.needYou }, 200);
  } catch (err) {
    return failed("fuel run", err);
  }
}
