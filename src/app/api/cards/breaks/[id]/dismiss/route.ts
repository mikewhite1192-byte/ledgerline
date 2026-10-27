import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { dismissBreak } from "@/lib/recon/run";
import { isUuid } from "@/lib/uuid";
import { failed, objectBody, refused, reply } from "../../../reply";

// POST { category }: a person closes one open difference with a reason (explained, duplicate,
// wrong system, other). It changes only the difference; nothing is paid, posted or sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.cardRecon.enabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  const body = await objectBody(request);
  if (!isUuid(id) || !body || typeof body.category !== "string") return refused("bad_request");
  try {
    const out = await dismissBreak(session, id, body.category);
    if (!out.ok) return refused(out.category);
    return reply({ ok: true }, 200);
  } catch (err) {
    return failed("card difference dismiss", err);
  }
}
