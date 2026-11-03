import { z } from "zod";
import { ACTIVATION_STEPS, activationOn, recordActivationStep } from "@/lib/advances/activation";
import { refuse, reply } from "@/lib/advances/http";
import { advancesOn } from "@/lib/advances/switches";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST { step, cardId, note? }: an admin records one activation step on the driver's default card
// (src/lib/advances/activation.ts): identity confirmed, zero test sent or loads acknowledged. cardId
// is the card the page showed; another default card now is card_changed. The same step again is no
// change. The checklist's switch is asked here once the caller is known to be
// staff, so a signed-out caller learns nothing of it, and again by the service; off, the answer is
// 404. Nothing is paid or sent. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({
  step: z.enum(ACTIVATION_STEPS),
  cardId: z.string().refine(isUuid),
  note: z.string().max(240).optional(),
});

// 404, not the 403 the advances switch answers: an unreleased route stays hidden, as the named
// lines route does.
const switchedOff = () => reply({ error: "disabled", retryable: false }, 404);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return refuse("forbidden");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  if (!activationOn()) return switchedOff();
  // Arming rides the advances switch, and so does a step toward it.
  if (!advancesOn()) return refuse("disabled");
  const { id } = await params;
  if (!isUuid(id)) return refuse("bad_request");
  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return refuse("bad_request");
    body = parsed.data;
  } catch {
    return refuse("bad_request");
  }
  try {
    const result = await recordActivationStep(session, id.toLowerCase(), {
      step: body.step,
      cardId: body.cardId.toLowerCase(),
      note: body.note ?? null,
    });
    if (result.ok) return reply(result, 200);
    if (result.category === "disabled") return switchedOff();
    return refuse(result.category, result.retryable);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("activation step failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
