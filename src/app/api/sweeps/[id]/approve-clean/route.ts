import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { approveClean, parseApproveClean } from "@/lib/sweep/approve-clean";
import { isUuid } from "@/lib/uuid";
import { failed, objectBody, refused, reply } from "../../reply";

// POST: "Approve all clean". Body { batchId (a uuid the page made), proposalIds (1..25),
// totalCents }: the list and total the button showed. The server re-checks every one; any change
// refuses the whole batch (409 changed, with what is clean now) so the person confirms what they
// saw. A replayed batch id with the same list and total answers with the stored result and never
// executes twice; the same id with a different list or total is refused (409 batch_reused).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.sweepEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return refused("bad_request");
  const input = parseApproveClean(await objectBody(request, 8_000));
  if (!input) return refused("bad_request");
  try {
    const result = await approveClean(session, id, input);
    if (result.ok) return reply(result, 200);
    if (result.category === "changed") {
      return refused("changed", { clean: result.clean, totalCents: result.totalCents });
    }
    return refused(result.category);
  } catch (err) {
    return failed("sweep approve-clean", err);
  }
}
