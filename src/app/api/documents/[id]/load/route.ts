import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { createLoadCard } from "@/lib/ratecon/service";
import { isUuid } from "@/lib/uuid";
import { failure, REFUSAL_STATUS, reply } from "../../reply";

// POST: read a rate confirmation for a load no record holds once more, under its own schema, and
// propose the load as a card a person approves. Nothing is created here: the load is written only
// by the approval's executor. A card already made is returned as it is, with no second read. Staff
// only: a demo visitor (the judge role) is refused before any work. Both switches are read here,
// and again inside the service and the read.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOAD_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  ...REFUSAL_STATUS,
  not_rate_confirmation: 409,
  has_record: 409,
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled || !flags.ratecon.enabled) return reply({ error: "disabled" }, 404);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const outcome = await createLoadCard(session, id);
    if (!outcome.ok) return reply({ error: outcome.error }, LOAD_REFUSAL_STATUS[outcome.error] ?? 409);
    return reply({ ratecon: outcome.view }, 200);
  } catch (err) {
    return failure("load card", err);
  }
}
