import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { proposeFuelCorrection } from "@/lib/fuel/propose";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";
import { failed, refused, reply } from "../../../reply";

// POST: a finding's "Propose a pay correction". Drafts the engine's correction as a card a person
// approves; nothing is paid or written to pay from here.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.fuelAnomalyEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return refused("bad_request");
  try {
    const out = await proposeFuelCorrection(session, id);
    if (!out.ok) return refused(out.category);
    return reply({ proposalId: out.proposalId, existing: out.existing }, 200);
  } catch (err) {
    return failed("fuel propose", err);
  }
}
